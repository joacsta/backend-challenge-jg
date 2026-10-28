import { EntityManager, LockMode } from "@mikro-orm/core";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { Money } from "../../domain/money/money";
import { WalletEntity } from "../../infrastructure/persistence/entities/wallet.entity";
import { WagerTransactionEntity } from "../../infrastructure/persistence/entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "../../infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "../../infrastructure/persistence/entities/outbox-message.entity";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";

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
}

@Injectable()
export class WageringApplicationService {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService = new MetricsService(),
    private readonly logger: StructuredLoggerService = new StructuredLoggerService(),
  ) {}

  async findTransactionById(transactionId: string) {
    const transaction = await this.em.findOne(WagerTransactionEntity, { id: transactionId });
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
      observedBalance: transaction.observedBalance ? { amount: transaction.observedBalance, currency: transaction.currency } : null,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt,
    };
  }

  async findTransactionByProviderReference(providerId: string, externalTransactionId: string) {
    const transaction = await this.em.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });

    if (!transaction) {
      throw new NotFoundException("Transaction not found for provider reference");
    }

    return this.findTransactionById(transaction.id);
  }

  async submitWager(input: SubmitWagerInput, idempotencyKeyHeader?: string) {
    const idempotencyKey =
      idempotencyKeyHeader ?? `${input.providerId}:${input.externalTransactionId}`;

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

    const resolvedExisting = existingByKey ?? existingByExternalId;

    if (resolvedExisting) {
      if (resolvedExisting.payloadHash !== payloadHash) {
        this.metrics.increment("idempotency.payload_conflict");
        this.logger.warn("idempotency.payload_conflict", { idempotencyKey, providerId: input.providerId, externalTransactionId: input.externalTransactionId });
        throw new ConflictException("Idempotency key already used with different payload");
      }

      this.metrics.increment("idempotency.replay");
      return {
        transactionId: resolvedExisting.id,
        status: resolvedExisting.status,
        balance: { amount: resolvedExisting.observedBalance ?? "0.00", currency: resolvedExisting.currency },
        idempotentReplay: true,
      };
    }

    let result: {
      transactionId: string;
      status: string;
      balance: { amount: string; currency: string };
      idempotentReplay: boolean;
    };

    await this.em.transactional(async (tx: EntityManager) => {
      const wallet = await tx.findOne(
        WalletEntity,
        { id: input.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!wallet) {
        throw new NotFoundException("Wallet not found");
      }

      const currentByKey = await tx.findOne(WagerTransactionEntity, { idempotencyKey });
      const currentByExternalId = await tx.findOne(WagerTransactionEntity, {
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
      });

      const current = currentByKey ?? currentByExternalId;
      if (current) {
        if (current.payloadHash !== payloadHash) {
          this.metrics.increment("idempotency.payload_conflict");
          this.logger.warn("idempotency.payload_conflict", { idempotencyKey, providerId: input.providerId, externalTransactionId: input.externalTransactionId });
          throw new ConflictException("Idempotency key already used with different payload");
        }

        this.metrics.increment("idempotency.replay");
        result = {
          transactionId: current.id,
          status: current.status,
          balance: { amount: current.observedBalance ?? "0.00", currency: current.currency },
          idempotentReplay: true,
        };
        return;
      }

      const amount = Money.from(input.money);
      const oneTx = tx.create(WagerTransactionEntity, {
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

      if (input.kind === "BET") {
        const available = Money.from({ amount: wallet.balance, currency: wallet.currency });
        if (available.isLessThan(amount)) {
          oneTx.status = "REJECTED";
          oneTx.failureCode = "INSUFFICIENT_FUNDS";
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

        const before = Money.from({ amount: wallet.balance, currency: wallet.currency });
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

        tx.create(OutboxMessageEntity, {
          id: randomUUID(),
          aggregateId: wallet.id,
          eventType: "wallet.balance.changed",
          payload: {
            walletId: wallet.id,
            playerId: wallet.playerId,
            currency: wallet.currency,
            walletVersion: wallet.version,
            transactionId: oneTx.id,
            direction: "DEBIT",
            amount: amount.toJSON().amount,
            balanceBefore: before.toJSON().amount,
            balanceAfter: next.toJSON().amount,
          },
          occurredAt: new Date(),
          attempts: 0,
          nextAttemptAt: new Date(),
          publishedAt: null,
        });
      }

      if (input.kind === "WIN") {
        const before = Money.from({ amount: wallet.balance, currency: wallet.currency });
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

        tx.create(OutboxMessageEntity, {
          id: randomUUID(),
          aggregateId: wallet.id,
          eventType: "wallet.balance.changed",
          payload: {
            walletId: wallet.id,
            playerId: wallet.playerId,
            currency: wallet.currency,
            walletVersion: wallet.version,
            transactionId: oneTx.id,
            direction: "CREDIT",
            amount: amount.toJSON().amount,
            balanceBefore: before.toJSON().amount,
            balanceAfter: next.toJSON().amount,
          },
          occurredAt: new Date(),
          attempts: 0,
          nextAttemptAt: new Date(),
          publishedAt: null,
        });
      }

      if (input.kind === "LOSS") {
        oneTx.status = "PROCESSED";
        oneTx.processedAt = new Date();
        oneTx.observedBalance = wallet.balance;
      }

      this.metrics.increment("wager.transaction.processed");
      this.logger.log("wager.transaction.processed", {
        transactionId: oneTx.id,
        walletId: wallet.id,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        status: oneTx.status,
        amount: amount.toJSON().amount,
      });
      await tx.flush();
      result = {
        transactionId: oneTx.id,
        status: oneTx.status,
        balance: { amount: wallet.balance, currency: wallet.currency },
        idempotentReplay: false,
      };
    });

    return result!;
  }

  makePayloadHash(payload: Record<string, unknown>): string {
    return createHash("sha256").update(this.stableStringify(payload)).digest("hex");
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
        .map(([key, nested]) => `${JSON.stringify(key)}:${this.stableStringify(nested)}`);
      return `{${entries.join(",")}}`;
    }

    return JSON.stringify(value);
  }
}
