import {
  EntityManager,
  LockMode,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { Money } from "../../domain/money/money";
import { WalletEntity } from "../../infrastructure/persistence/entities/wallet.entity";
import { WagerTransactionEntity } from "../../infrastructure/persistence/entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "../../infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "../../infrastructure/persistence/entities/outbox-message.entity";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import {
  IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
  type LedgerDirection,
} from "../events/integration-events";

export interface SubmitWagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export interface SubmitWagerResult {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
}

const REPLAYABLE_UNIQUE_CONSTRAINTS = new Set([
  "wt_idempotency_uq",
  "wt_external_uq",
  "ledger_one_entry_per_tx_uq",
]);

@Injectable()
export class WageringApplicationService {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService = new MetricsService(),
    private readonly logger: StructuredLoggerService = new StructuredLoggerService(),
  ) {}

  async findTransactionById(transactionId: string) {
    const transaction = await this.em.findOne(WagerTransactionEntity, {
      id: transactionId,
    });
    if (!transaction) {
      throw new NotFoundException("Transaction not found");
    }

    return {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: { amount: transaction.amount, currency: transaction.currency },
      status: transaction.status,
      failureCode: transaction.failureCode,
      observedBalance: transaction.observedBalance
        ? {
            amount: transaction.observedBalance,
            currency: transaction.currency,
          }
        : null,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt,
    };
  }

  async findTransactionByProviderReference(
    providerId: string,
    externalTransactionId: string,
  ) {
    const transaction = await this.em.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });

    if (!transaction) {
      throw new NotFoundException(
        "Transaction not found for provider reference",
      );
    }

    return this.findTransactionById(transaction.id);
  }

  async submitWager(
    input: SubmitWagerInput,
    idempotencyKeyHeader?: string,
    transactionManager?: EntityManager,
  ) {
    const startedAt = Date.now();
    const idempotencyKey =
      idempotencyKeyHeader ??
      `${input.providerId}:${input.externalTransactionId}`;

    const payloadHash = this.makePayloadHash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });

    const existingByKey = await this.em.findOne(WagerTransactionEntity, {
      idempotencyKey,
    });

    const existingByExternalId = await this.em.findOne(WagerTransactionEntity, {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
    });

    if (
      existingByExternalId &&
      existingByExternalId.idempotencyKey !== idempotencyKey
    ) {
      throw new ConflictException(
        "External transaction already exists with a different idempotency key",
      );
    }

    const resolvedExisting = existingByKey ?? existingByExternalId;

    if (resolvedExisting) {
      if (resolvedExisting.payloadHash !== payloadHash) {
        this.metrics.increment("idempotency.payload_conflict");
        this.logger.warn("idempotency.payload_conflict", {
          idempotencyKey,
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
        });
        throw new ConflictException(
          "Idempotency key already used with different payload",
        );
      }

      if (resolvedExisting.status !== "PENDING_REFERENCE") {
        this.metrics.increment("idempotency.replay");
        return this.replayResult(resolvedExisting);
      }

      if (!this.isReferenceAttemptDue(resolvedExisting)) {
        this.metrics.increment("idempotency.replay");
        return this.replayResult(resolvedExisting);
      }
    }

    let result: SubmitWagerResult;

    const process = async (tx: EntityManager) => {
      const wallet = await tx.findOne(
        WalletEntity,
        { id: input.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!wallet) {
        throw new NotFoundException("Wallet not found");
      }

      const currentByKey = await tx.findOne(WagerTransactionEntity, {
        idempotencyKey,
      });
      const currentByExternalId = await tx.findOne(WagerTransactionEntity, {
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
      });

      const current = currentByKey ?? currentByExternalId;
      if (current) {
        if (
          currentByExternalId &&
          currentByExternalId.idempotencyKey !== idempotencyKey
        ) {
          throw new ConflictException(
            "External transaction already exists with a different idempotency key",
          );
        }

        if (current.walletId !== wallet.id) {
          throw new ConflictException(
            "Idempotency key already used for a different wallet",
          );
        }

        if (current.payloadHash !== payloadHash) {
          this.metrics.increment("idempotency.payload_conflict");
          this.logger.warn("idempotency.payload_conflict", {
            idempotencyKey,
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
          });
          throw new ConflictException(
            "Idempotency key already used with different payload",
          );
        }

        if (current.status !== "PENDING_REFERENCE") {
          this.metrics.increment("idempotency.replay");
          result = this.replayResult(current);
          return;
        }

        if (!this.isReferenceAttemptDue(current)) {
          this.metrics.increment("idempotency.replay");
          result = this.replayResult(current);
          return;
        }
      }

      const amount = Money.from(input.money);
      const oneTx =
        current ??
        tx.create(WagerTransactionEntity, {
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
        const reference = await tx.findOne(
          WagerTransactionEntity,
          {
            providerId: input.providerId,
            externalTransactionId: input.referenceExternalTransactionId,
          },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (!reference) {
          const attempts = (oneTx.attempts ?? 0) + 1;
          oneTx.attempts = attempts;
          if (attempts >= this.maxReferenceAttempts()) {
            oneTx.status = "REJECTED";
            oneTx.failureCode = "REFERENCE_NOT_FOUND";
            oneTx.processedAt = new Date();
            this.enqueueTransactionEvent(
              tx,
              WagerTransactionRejected.from(
                wallet.id,
                this.transactionEventData(oneTx),
                this.eventContext(input),
              ),
            );
          } else {
            oneTx.status = "PENDING_REFERENCE";
            oneTx.nextAttemptAt = this.nextReferenceAttempt(new Date(), attempts);
            this.enqueueTransactionEvent(
              tx,
              WagerTransactionPendingReference.from(
                wallet.id,
                this.transactionEventData(oneTx),
                this.eventContext(input),
              ),
            );
          }
          await tx.flush();
          result = {
            transactionId: oneTx.id,
            status: oneTx.status,
            balance: { amount: wallet.balance, currency: wallet.currency },
            idempotentReplay: false,
          };
          return;
        }

        const referenceFailure = this.validateReference(input, amount, wallet, reference);
        if (referenceFailure) {
          oneTx.status = "REJECTED";
          oneTx.failureCode = referenceFailure;
          oneTx.processedAt = new Date();
          oneTx.observedBalance = wallet.balance;
          this.metrics.increment("wager.transaction.rejected");
          this.enqueueTransactionEvent(
            tx,
            WagerTransactionRejected.from(
              wallet.id,
              this.transactionEventData(oneTx),
              this.eventContext(input),
            ),
          );
          await tx.flush();
          result = {
            transactionId: oneTx.id,
            status: oneTx.status,
            balance: { amount: wallet.balance, currency: wallet.currency },
            idempotentReplay: false,
          };
          return;
        }

        const alreadyReversed = await tx.findOne(WagerTransactionEntity, {
          referenceTransactionId: reference.id,
          kind: { $in: ["REFUND", "ROLLBACK"] },
          status: "PROCESSED",
        });
        if (alreadyReversed) {
          oneTx.status = "REJECTED";
          oneTx.failureCode = "ALREADY_REVERSED";
          oneTx.processedAt = new Date();
          oneTx.observedBalance = wallet.balance;
          this.metrics.increment("wager.transaction.rejected");
          this.enqueueTransactionEvent(
            tx,
            WagerTransactionRejected.from(
              wallet.id,
              this.transactionEventData(oneTx),
              this.eventContext(input),
            ),
          );
          await tx.flush();
          result = {
            transactionId: oneTx.id,
            status: oneTx.status,
            balance: { amount: wallet.balance, currency: wallet.currency },
            idempotentReplay: false,
          };
          return;
        }

        const direction = input.kind === "REFUND"
          ? "CREDIT"
          : this.rollbackDirection(reference.kind);
        const before = Money.from({
          amount: wallet.balance,
          currency: wallet.currency,
        });
        const next = direction === "CREDIT"
          ? before.add(amount)
          : before.subtract(amount);

        if (next.isNegative()) {
          oneTx.status = "REJECTED";
          oneTx.failureCode = "REVERSAL_INSUFFICIENT_FUNDS";
          oneTx.processedAt = new Date();
          oneTx.observedBalance = wallet.balance;
          this.metrics.increment("wager.transaction.rejected");
          await tx.flush();
          result = {
            transactionId: oneTx.id,
            status: oneTx.status,
            balance: { amount: wallet.balance, currency: wallet.currency },
            idempotentReplay: false,
          };
          return;
        }

        wallet.balance = next.toJSON().amount;
        wallet.version += 1;
        wallet.updatedAt = new Date();
        oneTx.referenceTransactionId = reference.id;
        oneTx.status = "PROCESSED";
        oneTx.processedAt = new Date();
        oneTx.observedBalance = wallet.balance;

        await tx.flush();
        tx.create(WalletLedgerEntryEntity, {
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: oneTx.id,
          direction,
          amount: amount.toJSON().amount,
          currency: amount.currency,
          balanceBefore: before.toJSON().amount,
          balanceAfter: next.toJSON().amount,
          createdAt: new Date(),
        });
        this.createBalanceChangedOutbox(
          tx,
          wallet,
          oneTx,
          direction,
          amount,
          before,
          next,
          this.eventContext(input),
        );
      }

      if (input.kind === "BET") {
        const available = Money.from({
          amount: wallet.balance,
          currency: wallet.currency,
        });
        if (available.isLessThan(amount)) {
          oneTx.status = "REJECTED";
          oneTx.failureCode = "INSUFFICIENT_FUNDS";
          oneTx.processedAt = new Date();
          oneTx.observedBalance = wallet.balance;
          this.metrics.increment("wager.transaction.rejected");
          this.enqueueTransactionEvent(
            tx,
            WagerTransactionRejected.from(
              wallet.id,
              this.transactionEventData(oneTx),
              this.eventContext(input),
            ),
          );
          await tx.flush();
          result = {
            transactionId: oneTx.id,
            status: oneTx.status,
            balance: { amount: wallet.balance, currency: wallet.currency },
            idempotentReplay: false,
          };
          return;
        }

        const before = Money.from({
          amount: wallet.balance,
          currency: wallet.currency,
        });
        const next = before.subtract(amount);
        wallet.balance = next.toJSON().amount;
        wallet.version += 1;
        wallet.updatedAt = new Date();
        oneTx.status = "PROCESSED";
        oneTx.processedAt = new Date();
        oneTx.observedBalance = next.toJSON().amount;

        await tx.flush();

        tx.create(WalletLedgerEntryEntity, {
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: oneTx.id,
          direction: "DEBIT",
          amount: amount.toJSON().amount,
          currency: amount.currency,
          balanceBefore: before.toJSON().amount,
          balanceAfter: next.toJSON().amount,
          createdAt: new Date(),
        });

        this.createBalanceChangedOutbox(
          tx,
          wallet,
          oneTx,
          "DEBIT",
          amount,
          before,
          next,
          this.eventContext(input),
        );
      }

      if (input.kind === "WIN") {
        const before = Money.from({
          amount: wallet.balance,
          currency: wallet.currency,
        });
        const next = before.add(amount);
        wallet.balance = next.toJSON().amount;
        wallet.version += 1;
        wallet.updatedAt = new Date();
        oneTx.status = "PROCESSED";
        oneTx.processedAt = new Date();
        oneTx.observedBalance = next.toJSON().amount;

        await tx.flush();

        tx.create(WalletLedgerEntryEntity, {
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: oneTx.id,
          direction: "CREDIT",
          amount: amount.toJSON().amount,
          currency: amount.currency,
          balanceBefore: before.toJSON().amount,
          balanceAfter: next.toJSON().amount,
          createdAt: new Date(),
        });

        this.createBalanceChangedOutbox(
          tx,
          wallet,
          oneTx,
          "CREDIT",
          amount,
          before,
          next,
          this.eventContext(input),
        );
      }

      if (input.kind === "LOSS") {
        oneTx.status = "PROCESSED";
        oneTx.processedAt = new Date();
        oneTx.observedBalance = wallet.balance;
      }

      this.metrics.increment("wager.transaction.processed");
      this.enqueueTransactionEvent(
        tx,
        WagerTransactionProcessed.from(
          wallet.id,
          this.transactionEventData(oneTx),
          this.eventContext(input),
        ),
      );
      this.logger.log("wager.transaction.processed", {
        correlationId: this.eventContext(input).correlationId,
        transactionId: oneTx.id,
        walletId: wallet.id,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        status: oneTx.status,
      });
      await tx.flush();
      result = {
        transactionId: oneTx.id,
        status: oneTx.status,
        balance: { amount: wallet.balance, currency: wallet.currency },
        idempotentReplay: false,
      };
    };

    try {
      if (transactionManager) {
        await process(transactionManager);
      } else {
        await this.em.transactional(process);
      }
    } catch (error) {
      if (this.isLockConflict(error)) {
        this.metrics.increment("wallet.lock_conflict");
      }

      const constraint = this.uniqueConstraintName(error);
      if (constraint === "wt_single_reversal_uq") {
        throw new ConflictException("Transaction already reversed");
      }

      if (constraint && !transactionManager) {
        const recovered = await this.recoverFromUniqueViolation(
          input,
          idempotencyKey,
          payloadHash,
          constraint,
        );
        if (recovered) {
          this.metrics.observe(
            "wager.processing_latency_ms",
            Date.now() - startedAt,
          );
          this.metrics.increment(
            `wager.status.${recovered.status.toLowerCase()}`,
          );
          return recovered;
        }
      }

      throw error;
    }

    this.metrics.observe("wager.processing_latency_ms", Date.now() - startedAt);
    this.metrics.increment(`wager.status.${result!.status.toLowerCase()}`);
    return result!;
  }

  private async recoverFromUniqueViolation(
    input: SubmitWagerInput,
    idempotencyKey: string,
    payloadHash: string,
    constraint: string,
  ): Promise<SubmitWagerResult | undefined> {
    if (!REPLAYABLE_UNIQUE_CONSTRAINTS.has(constraint)) {
      return undefined;
    }

    const reader = this.em.fork();
    const existingByKey = await reader.findOne(WagerTransactionEntity, {
      idempotencyKey,
    });
    const existingByExternalId = await reader.findOne(WagerTransactionEntity, {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
    });

    if (
      existingByExternalId &&
      existingByExternalId.idempotencyKey !== idempotencyKey
    ) {
      throw new ConflictException(
        "External transaction already exists with a different idempotency key",
      );
    }

    const existing = existingByKey ?? existingByExternalId;
    if (!existing) {
      return undefined;
    }

    if (existing.payloadHash !== payloadHash) {
      this.metrics.increment("idempotency.payload_conflict");
      this.logger.warn("idempotency.payload_conflict", {
        idempotencyKey,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
      });
      throw new ConflictException(
        "Idempotency key already used with different payload",
      );
    }

    this.metrics.increment("idempotency.replay");
    return this.replayResult(existing);
  }

  private uniqueConstraintName(error: unknown): string | undefined {
    if (!(error instanceof UniqueConstraintViolationException)) {
      return undefined;
    }

    const constraint = (error as { constraint?: unknown }).constraint;
    return typeof constraint === "string" ? constraint : undefined;
  }

  private replayResult(
    transaction: WagerTransactionEntity,
  ): SubmitWagerResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: {
        amount: transaction.observedBalance ?? "0.00",
        currency: transaction.currency,
      },
      idempotentReplay: true,
    };
  }

  private isReferenceAttemptDue(transaction: WagerTransactionEntity): boolean {
    return (
      !transaction.nextAttemptAt || transaction.nextAttemptAt <= new Date()
    );
  }

  private isLockConflict(error: unknown): boolean {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    return code === "55P03" || code === "40P01";
  }

  async processPendingReferences(limit = 25): Promise<number> {
    const now = new Date();
    const workerEm = this.em.fork();
    const pending = await workerEm.find(
      WagerTransactionEntity,
      { status: "PENDING_REFERENCE" },
      { limit, orderBy: { createdAt: "ASC" } },
    );
    const due = pending.filter(
      (transaction) =>
        !transaction.nextAttemptAt || transaction.nextAttemptAt <= now,
    );

    for (const transaction of due) {
      await workerEm.transactional((transactionEm) =>
        this.submitWager(
          {
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            playerId: transaction.playerId,
            walletId: transaction.walletId,
            roundId: transaction.roundId,
            gameId: transaction.gameId,
            kind: transaction.kind as SubmitWagerInput["kind"],
            money: {
              amount: transaction.amount,
              currency: transaction.currency,
            },
            referenceExternalTransactionId:
              transaction.referenceExternalTransactionId ?? undefined,
            correlationId: transaction.idempotencyKey,
          },
          transaction.idempotencyKey,
          transactionEm,
        ),
      );
    }

    return due.length;
  }

  makePayloadHash(payload: Record<string, unknown>): string {
    return createHash("sha256")
      .update(this.stableStringify(payload))
      .digest("hex");
  }

  private validateReference(
    input: SubmitWagerInput,
    amount: Money,
    wallet: WalletEntity,
    reference: WagerTransactionEntity,
  ): "INVALID_REFERENCE" | "REFERENCE_MISMATCH" | "INVALID_REFERENCE_KIND" | "REFERENCE_AMOUNT_MISMATCH" | undefined {
    if (
      reference.status !== "PROCESSED" ||
      reference.providerId !== input.providerId ||
      reference.playerId !== wallet.playerId ||
      reference.walletId !== wallet.id ||
      reference.roundId !== input.roundId ||
      reference.currency !== wallet.currency
    ) {
      return "REFERENCE_MISMATCH";
    }

    if (
      (input.kind === "REFUND" && reference.kind !== "BET") ||
      (input.kind === "ROLLBACK" &&
        !["BET", "WIN", "REFUND"].includes(reference.kind))
    ) {
      return "INVALID_REFERENCE_KIND";
    }

    if (
      Money.from({ amount: reference.amount, currency: reference.currency }).toJSON().amount !==
      amount.toJSON().amount
    ) {
      return "REFERENCE_AMOUNT_MISMATCH";
    }

    return undefined;
  }

  private rollbackDirection(referenceKind: string): "DEBIT" | "CREDIT" {
    return referenceKind === "BET" || referenceKind === "REFUND"
      ? "CREDIT"
      : "DEBIT";
  }

  private nextReferenceAttempt(now: Date, attempts: number): Date {
    const delay = Math.min(30_000 * 2 ** attempts, 300_000);
    return new Date(now.getTime() + delay);
  }

  private maxReferenceAttempts(): number {
    return Number(process.env.WAGER_REFERENCE_MAX_ATTEMPTS ?? "5");
  }

  private createBalanceChangedOutbox(
    tx: EntityManager,
    wallet: WalletEntity,
    transaction: WagerTransactionEntity,
    direction: "DEBIT" | "CREDIT",
    amount: Money,
    before: Money,
    after: Money,
    context: EventContext,
  ) {
    this.enqueueTransactionEvent(
      tx,
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

  private enqueueTransactionEvent(
    tx: EntityManager,
    event: IntegrationEvent<unknown>,
  ) {
    tx.create(OutboxMessageEntity, {
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: null,
    });
  }

  private eventContext(input: SubmitWagerInput): EventContext {
    return {
      correlationId:
        input.correlationId ??
        `${input.providerId}:${input.externalTransactionId}`,
      causationId: input.externalTransactionId,
    };
  }

  private transactionEventData(
    transaction: WagerTransactionEntity,
  ) {
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: {
        amount: transaction.amount,
        currency: transaction.currency,
      },
      status: transaction.status,
      ...(transaction.failureCode
        ? { failureCode: transaction.failureCode }
        : {}),
    };
  }

  private stableStringify(value: unknown): string {
    if (value === undefined) {
      return "null";
    }

    if (value === null) {
      return "null";
    }

    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(",")}]`;
    }

    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(
          ([key, nested]) =>
            `${JSON.stringify(key)}:${this.stableStringify(nested)}`,
        );
      return `{${entries.join(",")}}`;
    }

    return JSON.stringify(value);
  }
}
