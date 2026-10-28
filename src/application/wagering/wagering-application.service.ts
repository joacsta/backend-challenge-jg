import { EntityManager, LockMode } from "@mikro-orm/core";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { Money } from "../../domain/money/money";
import { WalletEntity } from "../../infrastructure/persistence/entities/wallet.entity";
import { WagerTransactionEntity } from "../../infrastructure/persistence/entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "../../infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "../../infrastructure/persistence/entities/outbox-message.entity";

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
  constructor(private readonly em: EntityManager) {}

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

    const existing = await this.em.findOne(WagerTransactionEntity, {
      idempotencyKey,
    });

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ConflictException("Idempotency key already used with different payload");
      }

      return {
        transactionId: existing.id,
        status: existing.status,
        balance: { amount: existing.observedBalance ?? "0.00", currency: existing.currency },
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
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    return createHash("sha256").update(canonical).digest("hex");
  }
}
