import { EntityManager } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";
import { OutboxMessageEntity } from "../persistence/entities/outbox-message.entity";
import { SqsTransportService } from "./sqs-transport.service";

export interface OutboxPublicationResult {
  id: string;
  eventType: string;
  published: boolean;
  publishedAt?: Date;
  nextAttemptAt?: Date;
  attempts: number;
}

@Injectable()
export class OutboxProcessorService {
  constructor(
    private readonly em: EntityManager,
    private readonly sqsTransport: SqsTransportService,
  ) {}

  async publishNextPending(limit = 50): Promise<OutboxPublicationResult[]> {
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

      const results: OutboxPublicationResult[] = [];

      for (const message of due) {
        const attemptsBefore = message.attempts ?? 0;

        try {
          await this.publishToTransport(message);
          message.publishedAt = now;
          message.attempts = attemptsBefore + 1;
          message.nextAttemptAt = now;
          results.push({
            id: message.id,
            eventType: message.eventType,
            published: true,
            publishedAt: message.publishedAt,
            attempts: message.attempts,
          });
        } catch (error) {
          const nextAttempts = attemptsBefore + 1;
          message.attempts = nextAttempts;
          message.nextAttemptAt = this.calculateNextAttemptAt(nextAttempts, now);
          results.push({
            id: message.id,
            eventType: message.eventType,
            published: false,
            nextAttemptAt: message.nextAttemptAt,
            attempts: message.attempts,
          });
        }
      }

      await tx.flush();

      return results;
    });
  }

  private async publishToTransport(message: OutboxMessageEntity): Promise<void> {
    await this.sqsTransport.publish(message);
  }

  private calculateNextAttemptAt(attemptNumber: number, base: Date): Date {
    const backoffMs = Math.min(30_000 * 2 ** (attemptNumber - 1), 300_000);
    return new Date(base.getTime() + backoffMs);
  }
}
