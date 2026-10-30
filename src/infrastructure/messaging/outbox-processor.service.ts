import { EntityManager, LockMode } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";
import { OutboxMessageEntity } from "../persistence/entities/outbox-message.entity";
import { SqsTransportService } from "./sqs-transport.service";
import { MetricsService } from "../observability/metrics.service";

export interface OutboxPublicationResult {
  id: string;
  eventType: string;
  published: boolean;
  deadLettered?: boolean;
  publishedAt?: Date;
  nextAttemptAt?: Date;
  attempts: number;
}

@Injectable()
export class OutboxProcessorService {
  private readonly maxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? "5");

  constructor(
    private readonly em: EntityManager,
    private readonly sqsTransport: SqsTransportService,
    private readonly metrics: MetricsService,
  ) {}

  async publishNextPending(limit = 50): Promise<OutboxPublicationResult[]> {
    return this.em.transactional(async (tx: EntityManager) => {
      const pending = await tx.find(
        OutboxMessageEntity,
        { publishedAt: null },
        {
          limit,
          orderBy: { occurredAt: "ASC" },
          lockMode: LockMode.PESSIMISTIC_WRITE,
        },
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
          this.metrics.increment("outbox.published");
          this.metrics.observe(
            "outbox.lag_ms",
            Math.max(0, now.getTime() - message.occurredAt.getTime()),
          );
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

          if (nextAttempts >= this.maxAttempts) {
            await this.sqsTransport.publishDeadLetter(message);
            message.publishedAt = now;
            message.nextAttemptAt = now;
            this.metrics.increment("outbox.dlq");
            results.push({
              id: message.id,
              eventType: message.eventType,
              published: false,
              deadLettered: true,
              publishedAt: message.publishedAt,
              attempts: message.attempts,
            });
            continue;
          }

          message.nextAttemptAt = this.calculateNextAttemptAt(
            nextAttempts,
            now,
          );
          this.metrics.increment("outbox.retry");
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

  private async publishToTransport(
    message: OutboxMessageEntity,
  ): Promise<void> {
    await this.sqsTransport.publish(message);
  }

  private calculateNextAttemptAt(attemptNumber: number, base: Date): Date {
    const backoffMs = Math.min(30_000 * 2 ** (attemptNumber - 1), 300_000);
    return new Date(base.getTime() + backoffMs);
  }
}
