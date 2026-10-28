import { defineEntity, p } from "@mikro-orm/postgresql";

export const OutboxMessageEntitySchema = defineEntity({
  name: "OutboxMessage",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary().defaultRaw("gen_random_uuid()"),
    aggregateId: p.uuid().fieldName("aggregate_id"),
    eventType: p.string().fieldName("event_type"),
    payload: p.json().fieldName("payload"),
    occurredAt: p.datetime().fieldName("occurred_at").defaultRaw("now()"),
    attempts: p.integer().default(0),
    nextAttemptAt: p.datetime().fieldName("next_attempt_at").defaultRaw("now()"),
    publishedAt: p.datetime().nullable().fieldName("published_at"),
  },
  indexes: [
    {
      name: "outbox_pending_idx",
      properties: ["nextAttemptAt"],
      where: "published_at IS NULL",
    },
  ],
});

export class OutboxMessageEntity extends OutboxMessageEntitySchema.class {}
OutboxMessageEntitySchema.setClass(OutboxMessageEntity);
