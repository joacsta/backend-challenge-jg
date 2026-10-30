import { ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { WagerTransactionEntity } from "../../infrastructure/persistence/entities/wager-transaction.entity";
import type { MetricsService } from "../../infrastructure/observability/metrics.service";
import type { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import { stableStringify } from "../../shared/stable-stringify";
import type {
  SubmitWagerInput,
  SubmitWagerResult,
} from "./wagering-application.service";
import { isReferenceAttemptDue } from "./wagering-reference-policy";

export type IdempotencyConflictReason = "external-key" | "wallet" | "payload";

export type IdempotencyOutcome =
  | { action: "proceed"; existing?: WagerTransactionEntity }
  | { action: "replay"; existing: WagerTransactionEntity }
  | { action: "conflict"; reason: IdempotencyConflictReason };

export function payloadForHash(
  input: SubmitWagerInput,
): Record<string, unknown> {
  return {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money,
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  };
}

export function makePayloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex");
}

export function replayResult(
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

export function decideIdempotency(
  existingByKey: WagerTransactionEntity | null,
  existingByExternalId: WagerTransactionEntity | null,
  params: {
    idempotencyKey: string;
    payloadHash: string;
    walletId?: string;
    replayOnly?: boolean;
  },
): IdempotencyOutcome {
  if (
    existingByExternalId &&
    existingByExternalId.idempotencyKey !== params.idempotencyKey
  ) {
    return { action: "conflict", reason: "external-key" };
  }

  const existing = existingByKey ?? existingByExternalId;
  if (!existing) {
    return { action: "proceed" };
  }

  if (params.walletId !== undefined && existing.walletId !== params.walletId) {
    return { action: "conflict", reason: "wallet" };
  }

  if (existing.payloadHash !== params.payloadHash) {
    return { action: "conflict", reason: "payload" };
  }

  if (params.replayOnly) {
    return { action: "replay", existing };
  }

  if (existing.status !== "PENDING_REFERENCE") {
    return { action: "replay", existing };
  }

  if (!isReferenceAttemptDue(existing)) {
    return { action: "replay", existing };
  }

  return { action: "proceed", existing };
}

export function resolveIdempotency(params: {
  existingByKey: WagerTransactionEntity | null;
  existingByExternalId: WagerTransactionEntity | null;
  idempotencyKey: string;
  payloadHash: string;
  input: SubmitWagerInput;
  walletId?: string;
  replayOnly?: boolean;
  metrics: MetricsService;
  logger: StructuredLoggerService;
}): IdempotencyOutcome {
  const outcome = decideIdempotency(
    params.existingByKey,
    params.existingByExternalId,
    {
      idempotencyKey: params.idempotencyKey,
      payloadHash: params.payloadHash,
      walletId: params.walletId,
      replayOnly: params.replayOnly,
    },
  );

  if (outcome.action === "conflict") {
    if (outcome.reason === "wallet") {
      throw new ConflictException(
        "Idempotency key already used for a different wallet",
      );
    }

    if (outcome.reason === "payload") {
      params.metrics.increment("idempotency.payload_conflict");
      params.logger.warn("idempotency.payload_conflict", {
        idempotencyKey: params.idempotencyKey,
        providerId: params.input.providerId,
        externalTransactionId: params.input.externalTransactionId,
      });
      throw new ConflictException(
        "Idempotency key already used with different payload",
      );
    }

    throw new ConflictException(
      "External transaction already exists with a different idempotency key",
    );
  }

  if (outcome.action === "replay") {
    params.metrics.increment("idempotency.replay");
  }

  return outcome;
}
