import { defineEntity, p } from "@mikro-orm/postgresql";

export const InboxMessageEntitySchema = defineEntity({
  name: "InboxMessage",
  tableName: "inbox_messages",
  properties: {
    id: p.uuid().primary().defaultRaw("gen_random_uuid()"),
    consumerName: p.string().fieldName("consumer_name").unique(),
    messageId: p.string().fieldName("message_id").unique(),
    payloadHash: p.string().length(64).fieldName("payload_hash"),
    receivedAt: p.datetime().fieldName("received_at").defaultRaw("now()"),
    processedAt: p.datetime().nullable().fieldName("processed_at"),
  },
});

export class InboxMessageEntity extends InboxMessageEntitySchema.class {}
InboxMessageEntitySchema.setClass(InboxMessageEntity);
