import type { EntityManager } from "@mikro-orm/core";
import { NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Money } from "../../domain/money/money";
import type { WalletEntity } from "../../infrastructure/persistence/entities/wallet.entity";
import { WagerTransactionEntity } from "../../infrastructure/persistence/entities/wager-transaction.entity";
import type { MetricsService } from "../../infrastructure/observability/metrics.service";
import type { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
} from "../events/integration-events";
import {
  betMovement,
  creditMovement,
  rollbackMovement,
} from "./wagering-balance-policy";
import { eventContext, transactionEventData } from "./wagering-events";
import { replayResult, resolveIdempotency } from "./wagering-idempotency";
import {
  maxReferenceAttempts,
  nextReferenceAttempt,
  validateReference,
} from "./wagering-reference-policy";
import {
  createLedgerEntry,
  enqueueOutboxEvent,
  findProcessedReversal,
  findTransactionByExternalReference,
  findTransactionByIdempotencyKey,
  lockReference,
  lockWallet,
} from "./wagering-transaction-store";
import type {
  SubmitWagerInput,
  SubmitWagerResult,
} from "./wagering-application.service";

export async function processWagerTransaction(params: {
  em: EntityManager;
  input: SubmitWagerInput;
  idempotencyKey: string;
  payloadHash: string;
  metrics: MetricsService;
  logger: StructuredLoggerService;
}): Promise<SubmitWagerResult> {
  const { em, input, idempotencyKey, payloadHash, metrics, logger } = params;

  const wallet = await lockWallet(em, input.walletId);
  if (!wallet) {
    throw new NotFoundException("Wallet not found");
  }

  const currentByKey = await findTransactionByIdempotencyKey(
    em,
    idempotencyKey,
  );
  const currentByExternalId = await findTransactionByExternalReference(
    em,
    input.providerId,
    input.externalTransactionId,
  );

  const decision = resolveIdempotency({
    existingByKey: currentByKey,
    existingByExternalId: currentByExternalId,
    idempotencyKey,
    payloadHash,
    input,
    walletId: wallet.id,
    metrics,
    logger,
  });
  if (decision.action === "replay") {
    return replayResult(decision.existing);
  }
  const current =
    decision.action === "proceed" ? decision.existing : undefined;

  const amount = Money.from(input.money);
  const oneTx =
    current ??
    em.create(WagerTransactionEntity, {
      id: randomUUID(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      amount: amount.toJSON().amount,
      currency: amount.currency,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      status: "PENDING",
      createdAt: new Date(),
    });

  if (input.kind === "REFUND" || input.kind === "ROLLBACK") {
    const reference = await lockReference(
      em,
      input.providerId,
      input.referenceExternalTransactionId,
    );

    if (!reference) {
      const attempts = (oneTx.attempts ?? 0) + 1;
      oneTx.attempts = attempts;
      oneTx.observedBalance = wallet.balance;
      if (attempts >= maxReferenceAttempts()) {
        oneTx.status = "REJECTED";
        oneTx.failureCode = "REFERENCE_NOT_FOUND";
        oneTx.processedAt = new Date();
        enqueueOutboxEvent(
          em,
          WagerTransactionRejected.from(
            wallet.id,
            transactionEventData(oneTx),
            eventContext(input),
          ),
        );
      } else {
        oneTx.status = "PENDING_REFERENCE";
        oneTx.nextAttemptAt = nextReferenceAttempt(new Date(), attempts);
        enqueueOutboxEvent(
          em,
          WagerTransactionPendingReference.from(
            wallet.id,
            transactionEventData(oneTx),
            eventContext(input),
          ),
        );
      }
      await em.flush();
      return {
        transactionId: oneTx.id,
        status: oneTx.status,
        balance: { amount: wallet.balance, currency: wallet.currency },
        idempotentReplay: false,
      };
    }

    const referenceFailure = validateReference(
      input,
      amount,
      wallet,
      reference,
    );
    if (referenceFailure) {
      oneTx.status = "REJECTED";
      oneTx.failureCode = referenceFailure;
      oneTx.processedAt = new Date();
      oneTx.observedBalance = wallet.balance;
      metrics.increment("wager.transaction.rejected");
      enqueueOutboxEvent(
        em,
        WagerTransactionRejected.from(
          wallet.id,
          transactionEventData(oneTx),
          eventContext(input),
        ),
      );
      await em.flush();
      return {
        transactionId: oneTx.id,
        status: oneTx.status,
        balance: { amount: wallet.balance, currency: wallet.currency },
        idempotentReplay: false,
      };
    }

    const alreadyReversed = await findProcessedReversal(em, reference.id);
    if (alreadyReversed) {
      oneTx.status = "REJECTED";
      oneTx.failureCode = "ALREADY_REVERSED";
      oneTx.processedAt = new Date();
      oneTx.observedBalance = wallet.balance;
      metrics.increment("wager.transaction.rejected");
      enqueueOutboxEvent(
        em,
        WagerTransactionRejected.from(
          wallet.id,
          transactionEventData(oneTx),
          eventContext(input),
        ),
      );
      await em.flush();
      return {
        transactionId: oneTx.id,
        status: oneTx.status,
        balance: { amount: wallet.balance, currency: wallet.currency },
        idempotentReplay: false,
      };
    }

    const movement =
      input.kind === "REFUND"
        ? creditMovement(
            { amount: wallet.balance, currency: wallet.currency },
            amount,
          )
        : rollbackMovement(
            { amount: wallet.balance, currency: wallet.currency },
            amount,
            reference.kind,
          );

    if ("failureCode" in movement) {
      oneTx.status = "REJECTED";
      oneTx.failureCode = movement.failureCode;
      oneTx.processedAt = new Date();
      oneTx.observedBalance = wallet.balance;
      metrics.increment("wager.transaction.rejected");
      await em.flush();
      return {
        transactionId: oneTx.id,
        status: oneTx.status,
        balance: { amount: wallet.balance, currency: wallet.currency },
        idempotentReplay: false,
      };
    }

    const { direction, before, after: next } = movement;
    wallet.balance = next.toJSON().amount;
    wallet.version += 1;
    wallet.updatedAt = new Date();
    oneTx.referenceTransactionId = reference.id;
    oneTx.status = "PROCESSED";
    oneTx.processedAt = new Date();
    oneTx.observedBalance = wallet.balance;

    await em.flush();
    createLedgerEntry(em, {
      walletId: wallet.id,
      transactionId: oneTx.id,
      direction,
      amount: amount.toJSON().amount,
      currency: amount.currency,
      balanceBefore: before.toJSON().amount,
      balanceAfter: next.toJSON().amount,
    });
    createBalanceChangedOutbox(
      em,
      wallet,
      oneTx,
      direction,
      amount,
      before,
      next,
      eventContext(input),
    );
  }

  if (input.kind === "BET") {
    const movement = betMovement(
      { amount: wallet.balance, currency: wallet.currency },
      amount,
    );
    if ("failureCode" in movement) {
      oneTx.status = "REJECTED";
      oneTx.failureCode = movement.failureCode;
      oneTx.processedAt = new Date();
      oneTx.observedBalance = wallet.balance;
      metrics.increment("wager.transaction.rejected");
      enqueueOutboxEvent(
        em,
        WagerTransactionRejected.from(
          wallet.id,
          transactionEventData(oneTx),
          eventContext(input),
        ),
      );
      await em.flush();
      return {
        transactionId: oneTx.id,
        status: oneTx.status,
        balance: { amount: wallet.balance, currency: wallet.currency },
        idempotentReplay: false,
      };
    }

    const { direction, before, after: next } = movement;
    wallet.balance = next.toJSON().amount;
    wallet.version += 1;
    wallet.updatedAt = new Date();
    oneTx.status = "PROCESSED";
    oneTx.processedAt = new Date();
    oneTx.observedBalance = next.toJSON().amount;

    await em.flush();

    createLedgerEntry(em, {
      walletId: wallet.id,
      transactionId: oneTx.id,
      direction,
      amount: amount.toJSON().amount,
      currency: amount.currency,
      balanceBefore: before.toJSON().amount,
      balanceAfter: next.toJSON().amount,
    });

    createBalanceChangedOutbox(
      em,
      wallet,
      oneTx,
      direction,
      amount,
      before,
      next,
      eventContext(input),
    );
  }

  if (input.kind === "WIN") {
    const { direction, before, after: next } = creditMovement(
      { amount: wallet.balance, currency: wallet.currency },
      amount,
    );
    wallet.balance = next.toJSON().amount;
    wallet.version += 1;
    wallet.updatedAt = new Date();
    oneTx.status = "PROCESSED";
    oneTx.processedAt = new Date();
    oneTx.observedBalance = next.toJSON().amount;

    await em.flush();

    createLedgerEntry(em, {
      walletId: wallet.id,
      transactionId: oneTx.id,
      direction,
      amount: amount.toJSON().amount,
      currency: amount.currency,
      balanceBefore: before.toJSON().amount,
      balanceAfter: next.toJSON().amount,
    });

    createBalanceChangedOutbox(
      em,
      wallet,
      oneTx,
      direction,
      amount,
      before,
      next,
      eventContext(input),
    );
  }

  if (input.kind === "LOSS") {
    oneTx.status = "PROCESSED";
    oneTx.processedAt = new Date();
    oneTx.observedBalance = wallet.balance;
  }

  metrics.increment("wager.transaction.processed");
  enqueueOutboxEvent(
    em,
    WagerTransactionProcessed.from(
      wallet.id,
      transactionEventData(oneTx),
      eventContext(input),
    ),
  );
  logger.log("wager.transaction.processed", {
    correlationId: eventContext(input).correlationId,
    transactionId: oneTx.id,
    walletId: wallet.id,
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    status: oneTx.status,
  });
  await em.flush();
  return {
    transactionId: oneTx.id,
    status: oneTx.status,
    balance: { amount: wallet.balance, currency: wallet.currency },
    idempotentReplay: false,
  };
}

function createBalanceChangedOutbox(
  em: EntityManager,
  wallet: WalletEntity,
  transaction: WagerTransactionEntity,
  direction: "DEBIT" | "CREDIT",
  amount: Money,
  before: Money,
  after: Money,
  context: EventContext,
) {
  enqueueOutboxEvent(
    em,
    WalletBalanceChanged.from(
      wallet.id,
      {
        walletId: wallet.id,
        transactionId: transaction.id,
        direction,
        money: amount.toJSON(),
        balanceBefore: before.toJSON(),
        balanceAfter: after.toJSON(),
        walletVersion: wallet.version,
      },
      context,
    ),
  );
}
