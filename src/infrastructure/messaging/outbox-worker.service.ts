import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { OutboxProcessorService } from "./outbox-processor.service";
import { SqsTransportService } from "./sqs-transport.service";

@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly outboxProcessor: OutboxProcessorService,
    private readonly sqsTransport: SqsTransportService,
  ) {}

  onModuleInit() {
    if (!process.env.AWS_SQS_OUTBOX_URL) {
      this.logger.warn("AWS_SQS_OUTBOX_URL not configured; outbox worker disabled.");
      return;
    }

    this.start();
  }

  onApplicationShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.pollOnce();
    }, 5_000);

    void this.pollOnce();
  }

  private async pollOnce() {
    try {
      if (!this.sqsTransport) {
        return;
      }

      const published = await this.outboxProcessor.publishNextPending(25);
      if (published.length > 0) {
        this.logger.debug(`Published ${published.length} pending outbox events`);
      }
    } catch (error) {
      this.logger.error(
        "Outbox worker failed while publishing pending messages",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
