import { EntityManager } from "@mikro-orm/core";
import { ConflictException, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { InboxMessageEntity } from "../persistence/entities/inbox-message.entity";

export interface InboxEnvelope<T> {
  consumerName: string;
  messageId: string;
  payload: T;
}

@Injectable()
export class InboxMessageService {
  constructor(private readonly em: EntityManager) {}

  async consume<T>(envelope: InboxEnvelope<T>): Promise<boolean> {
    const payloadHash = this.payloadHash(envelope.payload);

    return this.em.transactional(async (tx: EntityManager) => {
      const existing = await tx.findOne(InboxMessageEntity, {
        consumerName: envelope.consumerName,
        messageId: envelope.messageId,
      });

      if (!existing) {
        tx.create(InboxMessageEntity, {
          id: randomUUID(),
          consumerName: envelope.consumerName,
          messageId: envelope.messageId,
          payloadHash,
          receivedAt: new Date(),
        });
        await tx.flush();
        return false;
      }

      if (existing.payloadHash !== payloadHash) {
        throw new ConflictException("Message payload hash mismatch for the same consumer/message id");
      }

      existing.processedAt ??= new Date();
      await tx.flush();
      return true;
    });
  }

  private payloadHash(payload: unknown): string {
    const normalized = payload && typeof payload === "object" && !Array.isArray(payload)
      ? JSON.stringify(payload, Object.keys(payload as Record<string, unknown>).sort())
      : JSON.stringify(payload);

    return createHash("sha256").update(normalized).digest("hex");
  }
}
