import { defineEntity, p } from "@mikro-orm/postgresql";

export const WagerTransactionEntitySchema = defineEntity({
  name: "WagerTransaction",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary().defaultRaw("gen_random_uuid()"),
    providerId: p.string().fieldName("provider_id"),
    externalTransactionId: p.string().fieldName("external_transaction_id"),
    idempotencyKey: p.string().fieldName("idempotency_key").unique(),
    payloadHash: p.string().length(64).fieldName("payload_hash"),
    walletId: p.uuid().fieldName("wallet_id"),
    playerId: p.uuid().fieldName("player_id"),
    roundId: p.string().fieldName("round_id"),
    gameId: p.string().fieldName("game_id"),
    kind: p.string(),
    amount: p.decimal().precision(18).scale(2),
    currency: p.string().length(3),
    referenceExternalTransactionId: p.string().nullable().fieldName("reference_external_transaction_id"),
    referenceTransactionId: p.uuid().nullable().fieldName("reference_transaction_id"),
    status: p.string(),
    failureCode: p.string().nullable().fieldName("failure_code"),
    observedBalance: p.decimal().precision(18).scale(2).nullable().fieldName("observed_balance"),
    attempts: p.integer().default(0),
    nextAttemptAt: p.datetime().nullable().fieldName("next_attempt_at"),
    createdAt: p.datetime().fieldName("created_at").defaultRaw("now()"),
    processedAt: p.datetime().nullable().fieldName("processed_at"),
  },
});

export class WagerTransactionEntity extends WagerTransactionEntitySchema.class {}
WagerTransactionEntitySchema.setClass(WagerTransactionEntity);
