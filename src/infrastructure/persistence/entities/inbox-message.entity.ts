import { defineEntity, p } from "@mikro-orm/postgresql";

export const InboxMessageEntitySchema = defineEntity({
  name: "InboxMessage",
  tableName: "inbox_messages",
  properties: {
    consumerName: p.string().fieldName("consumer_name").primary(),
    messageId: p.string().fieldName("message_id").primary(),
    payloadHash: p.string().length(64).fieldName("payload_hash"),
    receivedAt: p.datetime().fieldName("received_at").defaultRaw("now()"),
    processedAt: p.datetime().nullable().fieldName("processed_at"),
  },
});

export class InboxMessageEntity extends InboxMessageEntitySchema.class {}
InboxMessageEntitySchema.setClass(InboxMessageEntity);
