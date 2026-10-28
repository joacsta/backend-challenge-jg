import { defineEntity, p } from "@mikro-orm/postgresql";

export const InboxMessageEntitySchema = defineEntity({
  name: "InboxMessage",
  tableName: "inbox_messages",
  properties: {
    id: p.uuid().primary().defaultRaw("gen_random_uuid()"),
    consumerName: p.string().fieldName("consumer_name"),
    messageId: p.string().fieldName("message_id"),
    payloadHash: p.string().length(64).fieldName("payload_hash"),
    receivedAt: p.datetime().fieldName("received_at").defaultRaw("now()"),
    processedAt: p.datetime().nullable().fieldName("processed_at"),
  },
  indexes: [
    {
      name: "inbox_consumer_message_idx",
      properties: ["consumerName", "messageId"],
    },
  ],
});

export class InboxMessageEntity extends InboxMessageEntitySchema.class {}
InboxMessageEntitySchema.setClass(InboxMessageEntity);
