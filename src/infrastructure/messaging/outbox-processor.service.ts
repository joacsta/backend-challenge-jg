import { EntityManager } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";
import { OutboxMessageEntity } from "../persistence/entities/outbox-message.entity";

@Injectable()
export class OutboxProcessorService {
  constructor(private readonly em: EntityManager) {}

  async publishNextPending(limit = 50): Promise<Array<{ id: string; eventType: string; publishedAt: Date }>> {
    return this.em.transactional(async (tx: EntityManager) => {
      const pending = await tx.find(
        OutboxMessageEntity,
        { publishedAt: null },
        { limit, orderBy: { occurredAt: "ASC" } },
      );

      const now = new Date();
      const due = pending.filter((message) => {
        if (!message.nextAttemptAt) {
          return true;
        }
        return message.nextAttemptAt <= now;
      });

      for (const message of due) {
        message.publishedAt = now;
        message.attempts += 1;
      }

      await tx.flush();

      return due.map((message) => ({
        id: message.id,
        eventType: message.eventType,
        publishedAt: message.publishedAt ?? now,
      }));
    });
  }
}
