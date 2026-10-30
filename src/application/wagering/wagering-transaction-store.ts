import {
  type EntityManager,
  LockMode,
  UniqueConstraintViolationException,
} from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import type { IntegrationEvent } from "../events/integration-events";
import { WalletEntity } from "../../infrastructure/persistence/entities/wallet.entity";
import { WagerTransactionEntity } from "../../infrastructure/persistence/entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "../../infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "../../infrastructure/persistence/entities/outbox-message.entity";

export interface LedgerEntryProps {
  walletId: string;
  transactionId: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
}

export function findTransactionEntityById(
  em: EntityManager,
  transactionId: string,
) {
  return em.findOne(WagerTransactionEntity, { id: transactionId });
}

export function findTransactionByIdempotencyKey(
  em: EntityManager,
  idempotencyKey: string,
) {
  return em.findOne(WagerTransactionEntity, { idempotencyKey });
}

export function findTransactionByExternalReference(
  em: EntityManager,
  providerId: string,
  externalTransactionId: string | undefined,
) {
  return em.findOne(WagerTransactionEntity, {
    providerId,
    externalTransactionId,
  });
}

export function lockWallet(em: EntityManager, walletId: string) {
  return em.findOne(
    WalletEntity,
    { id: walletId },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  );
}

export function lockReference(
  em: EntityManager,
  providerId: string,
  externalTransactionId: string | undefined,
) {
  return em.findOne(
    WagerTransactionEntity,
    { providerId, externalTransactionId },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  );
}

export function findProcessedReversal(
  em: EntityManager,
  referenceTransactionId: string,
) {
  return em.findOne(WagerTransactionEntity, {
    referenceTransactionId,
    kind: { $in: ["REFUND", "ROLLBACK"] },
    status: "PROCESSED",
  });
}

export function findPendingReferences(em: EntityManager, limit: number) {
  return em.find(
    WagerTransactionEntity,
    { status: "PENDING_REFERENCE" },
    { limit, orderBy: { createdAt: "ASC" } },
  );
}

export function createLedgerEntry(
  em: EntityManager,
  props: LedgerEntryProps,
): void {
  em.create(WalletLedgerEntryEntity, {
    id: randomUUID(),
    ...props,
    createdAt: new Date(),
  });
}

export function enqueueOutboxEvent(
  em: EntityManager,
  event: IntegrationEvent<unknown>,
): void {
  em.create(OutboxMessageEntity, {
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

export function uniqueConstraintName(error: unknown): string | undefined {
  if (!(error instanceof UniqueConstraintViolationException)) {
    return undefined;
  }

  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === "string" ? constraint : undefined;
}

export function isLockConflict(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  return code === "55P03" || code === "40P01";
}
