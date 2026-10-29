import { EntityManager } from "@mikro-orm/core";
import { ConflictException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { InboxMessageEntity } from "../persistence/entities/inbox-message.entity";
import { MetricsService } from "../observability/metrics.service";

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
      const existing = await tx.findOne(InboxMessageEntity, {
        consumerName: envelope.consumerName,
        messageId: envelope.messageId,
      });

      if (existing?.processedAt) {
        if (existing.payloadHash !== payloadHash) {
          throw new ConflictException(
            "Message payload hash mismatch for the same consumer/message id",
          );
        }
        this.metrics.increment("inbox.redelivery");
        return true;
      }

      if (!existing) {
        tx.create(InboxMessageEntity, {
          consumerName: envelope.consumerName,
          messageId: envelope.messageId,
          payloadHash,
          receivedAt: new Date(),
        });
        await tx.flush();
      }

      if (existing && existing.payloadHash !== payloadHash) {
        this.metrics.increment("inbox.payload_conflict");
        throw new ConflictException(
          "Message payload hash mismatch for the same consumer/message id",
        );
      }

      if (handler) {
        await handler(tx, envelope.payload);
      }

      const received = existing ?? await tx.findOneOrFail(InboxMessageEntity, {
        consumerName: envelope.consumerName,
        messageId: envelope.messageId,
      });
      received.processedAt = new Date();
      await tx.flush();
      return false;
    });
  }

  private payloadHash(payload: unknown): string {
    const normalized =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? JSON.stringify(
            payload,
            Object.keys(payload as Record<string, unknown>).sort(),
          )
        : JSON.stringify(payload);

    return createHash("sha256").update(normalized).digest("hex");
  }
}
