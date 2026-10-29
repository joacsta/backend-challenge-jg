import { Body, Controller, Post } from "@nestjs/common";
import {
  InboxMessageService,
  type InboxEnvelope,
} from "../infrastructure/messaging/inbox-message.service";
import { OutboxProcessorService } from "../infrastructure/messaging/outbox-processor.service";

@Controller("queues")
export class QueueController {
  constructor(
    private readonly outboxProcessor: OutboxProcessorService,
    private readonly inboxMessageService: InboxMessageService,
  ) {}

  @Post("outbox/publish")
  async publishOutbox(@Body() body?: { limit?: number }) {
    return this.outboxProcessor.publishNextPending(body?.limit ?? 50);
  }

  @Post("inbox/consume")
  async consumeInbox(
    @Body() body: { consumerName: string; messageId: string; payload: unknown },
  ) {
    const envelope: InboxEnvelope<unknown> = {
      consumerName: body.consumerName,
      messageId: body.messageId,
      payload: body.payload,
    };

    return this.inboxMessageService.consume(envelope);
  }
}
