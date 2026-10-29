import { EntityManager, LockMode } from "@mikro-orm/core";
import { ConflictException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { InboxMessageEntity } from "../persistence/entities/inbox-message.entity";
import { MetricsService } from "../observability/metrics.service";
import { stableStringify } from "../../shared/stable-stringify";

export interface InboxEnvelope<T> {
  consumerName: string;
  messageId: string;
  payload: T;
}

export type InboxMessageHandler<T> = (
  transactionManager: EntityManager,
  payload: T,
) => Promise<unknown>;

@Injectable()
export class InboxMessageService {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
  ) {}

  async consume<T>(
    envelope: InboxEnvelope<T>,
    handler?: InboxMessageHandler<T>,
  ): Promise<boolean> {
    const payloadHash = this.payloadHash(envelope.payload);

    return this.em.transactional(async (tx: EntityManager) => {
      // ON CONFLICT keeps concurrent redeliveries from aborting the transaction
      // with a primary-key violation. The loser then waits here for the winner
      // and observes its committed row.
      await tx.getConnection().execute(
        `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
         values (?, ?, ?, now())
         on conflict (consumer_name, message_id) do nothing`,
        [envelope.consumerName, envelope.messageId, payloadHash],
        "run",
        tx.getTransactionContext(),
      );

      const received = await tx.findOne(
        InboxMessageEntity,
        {
          consumerName: envelope.consumerName,
          messageId: envelope.messageId,
        },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!received) {
        throw new Error("Inbox message row is missing after insert");
      }

      if (received.payloadHash !== payloadHash) {
        this.metrics.increment("inbox.payload_conflict");
        throw new ConflictException(
          "Message payload hash mismatch for the same consumer/message id",
        );
      }

      if (received.processedAt) {
        this.metrics.increment("inbox.redelivery");
        return true;
      }

      if (handler) {
        await handler(tx, envelope.payload);
      }

      received.processedAt = new Date();
      await tx.flush();
      return false;
    });
  }

  private payloadHash(payload: unknown): string {
    return createHash("sha256")
      .update(stableStringify(payload))
      .digest("hex");
  }
}
