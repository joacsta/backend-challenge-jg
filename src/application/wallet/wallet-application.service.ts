import { EntityManager, wrap } from "@mikro-orm/core";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Money, type MoneyProps } from "../../domain/money/money";
import { WalletEntity } from "../../infrastructure/persistence/entities/wallet.entity";
import { WagerTransactionEntity } from "../../infrastructure/persistence/entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "../../infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "../../infrastructure/persistence/entities/outbox-message.entity";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

@Injectable()
export class WalletApplicationService {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService = new MetricsService(),
    private readonly logger: StructuredLoggerService = new StructuredLoggerService(),
  ) {}

  async createWallet(input: CreateWalletInput, correlationId?: string) {
    const money = Money.from(input.initialBalance);

    return this.em.transactional(async (tx: EntityManager) => {
      const existing = await tx.findOne(WalletEntity, {
        playerId: input.playerId,
        currency: money.currency,
      });

      if (existing) {
        this.metrics.increment("wallet.duplicate");
        this.logger.warn("wallet.create.duplicate", { correlationId, playerId: input.playerId, currency: money.currency });
        throw new ConflictException("Wallet already exists for this player and currency");
      }

      const wallet = tx.create(WalletEntity, {
        id: randomUUID(),
        playerId: input.playerId,
        currency: money.currency,
        balance: money.toJSON().amount,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await tx.flush();
      this.metrics.increment("wallet.created");

      if (!money.isZero()) {
        const transactionId = randomUUID();
        const openingTx = tx.create(WagerTransactionEntity, {
          id: transactionId,
          providerId: "system",
          externalTransactionId: `wallet-open-${wallet.id}`,
          idempotencyKey: `system:wallet-open-${wallet.id}`,
          payloadHash: "0".repeat(64),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: "system",
          gameId: "wallet-open",
          kind: "OPENING",
          amount: money.toJSON().amount,
          currency: money.currency,
          status: "PROCESSED",
          observedBalance: money.toJSON().amount,
          createdAt: new Date(),
          processedAt: new Date(),
        });

        await tx.flush();

        tx.create(WalletLedgerEntryEntity, {
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: openingTx.id,
          direction: "CREDIT",
          amount: money.toJSON().amount,
          currency: money.currency,
          balanceBefore: "0.00",
          balanceAfter: money.toJSON().amount,
          createdAt: new Date(),
        });

        tx.create(OutboxMessageEntity, {
          id: randomUUID(),
          aggregateId: wallet.id,
          eventType: "wallet.created",
          payload: {
            walletId: wallet.id,
            playerId: wallet.playerId,
            currency: wallet.currency,
            balance: wallet.balance,
            transactionId: openingTx.id,
            version: wallet.version,
          },
          occurredAt: new Date(),
          attempts: 0,
          nextAttemptAt: new Date(),
          publishedAt: null,
        });
      }

      await tx.flush();
      this.logger.log("wallet.created", {
        correlationId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        version: wallet.version,
      });

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: { amount: wallet.balance, currency: wallet.currency },
        version: wallet.version,
      };
    });
  }

  async findById(walletId: string) {
    const wallet = await this.em.findOne(WalletEntity, { id: walletId });
    if (!wallet) {
      throw new NotFoundException("Wallet not found");
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: wallet.balance, currency: wallet.currency },
      version: wallet.version,
    };
  }

  async findWalletEntityById(walletId: string) {
    const wallet = await this.em.findOne(WalletEntity, { id: walletId });
    if (!wallet) {
      throw new NotFoundException("Wallet not found");
    }
    return wallet;
  }

  async findLedger(walletId: string, cursor?: string, limit = 50) {
    const wallet = await this.findWalletEntityById(walletId);
    const items = await this.em.find(
      WalletLedgerEntryEntity,
      { walletId: wallet.id },
      {
        limit: Math.min(Math.max(limit, 1), 100),
        orderBy: { createdAt: "ASC" },
      },
    );

    return {
      walletId: wallet.id,
      cursor: cursor ?? null,
      items: items.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: { amount: entry.amount, currency: entry.currency },
        balanceBefore: { amount: entry.balanceBefore, currency: entry.currency },
        balanceAfter: { amount: entry.balanceAfter, currency: entry.currency },
        createdAt: entry.createdAt,
      })),
    };
  }

  async reconcileWallet(
    walletId: string,
    storedBalance: MoneyProps,
    calculatedBalance: MoneyProps,
  ) {
    const wallet = await this.findWalletEntityById(walletId);
    const stored = Money.from(storedBalance);
    const calculated = Money.from(calculatedBalance);
    const difference = stored.subtract(calculated);
    const consistent = stored.equals(calculated);

    return {
      walletId: wallet.id,
      storedBalance: { amount: stored.toJSON().amount, currency: stored.currency },
      calculatedBalance: { amount: calculated.toJSON().amount, currency: calculated.currency },
      difference: { amount: difference.toJSON().amount, currency: difference.currency },
      consistent,
      checkedEntries: await this.em.count(WalletLedgerEntryEntity, { walletId: wallet.id }),
    };
  }

  async updateBalanceFromLedger(wallet: WalletEntity, delta: string, direction: "DEBIT" | "CREDIT") {
    const current = Money.from({ amount: wallet.balance, currency: wallet.currency });
    const deltaMoney = Money.from({ amount: delta, currency: wallet.currency });
    const next = direction === "DEBIT" ? current.subtract(deltaMoney) : current.add(deltaMoney);
    wrap(wallet).assign({
      balance: next.toJSON().amount,
      version: wallet.version + 1,
      updatedAt: new Date(),
    });
  }
}
