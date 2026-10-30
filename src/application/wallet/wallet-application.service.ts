import {
  EntityManager,
  UniqueConstraintViolationException,
  wrap,
} from "@mikro-orm/core";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Money, type MoneyProps } from "../../domain/money/money";
import { WalletEntity } from "../../infrastructure/persistence/entities/wallet.entity";
import { WagerTransactionEntity } from "../../infrastructure/persistence/entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "../../infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "../../infrastructure/persistence/entities/outbox-message.entity";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../events/integration-events";

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

    try {
      return await this.em.transactional((tx: EntityManager) =>
        this.createWalletInTransaction(tx, input, money, correlationId),
      );
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        (error as { constraint?: string }).constraint ===
          "wallets_player_currency_uq"
      ) {
        this.metrics.increment("wallet.duplicate");
        this.logger.warn("wallet.create.duplicate", {
          correlationId,
          playerId: input.playerId,
          currency: money.currency,
        });
        throw new ConflictException(
          "Wallet already exists for this player and currency",
        );
      }
      throw error;
    }
  }

  private async createWalletInTransaction(
    tx: EntityManager,
    input: CreateWalletInput,
    money: Money,
    correlationId?: string,
  ) {
    const existing = await tx.findOne(WalletEntity, {
      playerId: input.playerId,
      currency: money.currency,
    });

    if (existing) {
      this.metrics.increment("wallet.duplicate");
      this.logger.warn("wallet.create.duplicate", {
        correlationId,
        playerId: input.playerId,
        currency: money.currency,
      });
      throw new ConflictException(
        "Wallet already exists for this player and currency",
      );
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

      const context = {
        correlationId: correlationId ?? `wallet:${wallet.id}`,
        causationId: openingTx.id,
      };
      const balanceChanged = WalletBalanceChanged.from(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: openingTx.id,
          direction: "CREDIT",
          money: money.toJSON(),
          balanceBefore: { amount: "0.00", currency: money.currency },
          balanceAfter: money.toJSON(),
          walletVersion: wallet.version,
        },
        context,
      );
      const transactionProcessed = WagerTransactionProcessed.from(
        wallet.id,
        {
          transactionId: openingTx.id,
          providerId: openingTx.providerId,
          externalTransactionId: openingTx.externalTransactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: openingTx.roundId,
          gameId: openingTx.gameId,
          kind: openingTx.kind,
          money: money.toJSON(),
          status: openingTx.status,
        },
        context,
      );

      for (const event of [balanceChanged, transactionProcessed]) {
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
    const pageSize = Math.min(Math.max(limit, 1), 100);
    const afterSeq = cursor ? this.decodeLedgerCursor(cursor) : undefined;
    const items = await this.em.find(
      WalletLedgerEntryEntity,
      {
        walletId: wallet.id,
        ...(afterSeq ? { seq: { $gt: afterSeq } } : {}),
      },
      {
        limit: pageSize,
        orderBy: { seq: "ASC" },
      },
    );

    const lastSeq = items.at(-1)?.seq;
    return {
      walletId: wallet.id,
      cursor: cursor ?? null,
      nextCursor:
        items.length === pageSize && lastSeq !== undefined && lastSeq !== null
          ? this.encodeLedgerCursor(lastSeq)
          : null,
      items: items.map((entry) => ({
        seq: entry.seq === null ? null : String(entry.seq),
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: { amount: entry.amount, currency: entry.currency },
        balanceBefore: {
          amount: entry.balanceBefore,
          currency: entry.currency,
        },
        balanceAfter: { amount: entry.balanceAfter, currency: entry.currency },
        createdAt: entry.createdAt,
      })),
    };
  }

  private encodeLedgerCursor(seq: string | number | bigint): string {
    return Buffer.from(String(seq), "utf8").toString("base64url");
  }

  private decodeLedgerCursor(cursor: string): string {
    try {
      const decoded = Buffer.from(cursor, "base64url").toString("utf8");
      if (!/^[1-9]\d*$/.test(decoded)) {
        throw new Error("invalid sequence");
      }
      return decoded;
    } catch {
      throw new BadRequestException("Invalid ledger cursor");
    }
  }

  async reconcileWallet(
    walletId: string,
    _storedBalance?: MoneyProps,
    _calculatedBalance?: MoneyProps,
  ) {
    const wallet = await this.findWalletEntityById(walletId);
    const stored = Money.from({
      amount: wallet.balance,
      currency: wallet.currency,
    });
    const entries = await this.em.find(
      WalletLedgerEntryEntity,
      { walletId: wallet.id },
      { orderBy: { seq: "ASC" } },
    );
    let calculated = Money.zero(wallet.currency);
    for (const entry of entries) {
      const amount = Money.from({
        amount: entry.amount,
        currency: entry.currency,
      });
      calculated =
        entry.direction === "CREDIT"
          ? calculated.add(amount)
          : calculated.subtract(amount);
    }

    const difference = stored.subtract(calculated);
    const consistent = stored.equals(calculated);
    if (!consistent) {
      this.metrics.increment("wallet.reconciliation.mismatch");
      this.logger.warn("wallet.reconciliation.mismatch", {
        walletId: wallet.id,
        checkedEntries: entries.length,
      });
    }

    return {
      walletId: wallet.id,
      storedBalance: {
        amount: stored.toJSON().amount,
        currency: stored.currency,
      },
      calculatedBalance: {
        amount: calculated.toJSON().amount,
        currency: calculated.currency,
      },
      difference: {
        amount: difference.toJSON().amount,
        currency: difference.currency,
      },
      consistent,
      checkedEntries: entries.length,
    };
  }

  async updateBalanceFromLedger(
    wallet: WalletEntity,
    delta: string,
    direction: "DEBIT" | "CREDIT",
  ) {
    const current = Money.from({
      amount: wallet.balance,
      currency: wallet.currency,
    });
    const deltaMoney = Money.from({ amount: delta, currency: wallet.currency });
    const next =
      direction === "DEBIT"
        ? current.subtract(deltaMoney)
        : current.add(deltaMoney);
    wrap(wallet).assign({
      balance: next.toJSON().amount,
      version: wallet.version + 1,
      updatedAt: new Date(),
    });
  }
}
