import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { SqsInboxConsumerService } from "./sqs-inbox-consumer.service";

@Injectable()
export class InboxWorkerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(InboxWorkerService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly inboxConsumer: SqsInboxConsumerService) {}

  onModuleInit() {
    if (!process.env.AWS_SQS_INBOX_URL) {
      this.logger.warn("AWS_SQS_INBOX_URL not configured; inbox worker disabled.");
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
      const processed = await this.inboxConsumer.pollOnce(10);
      if (processed > 0) {
        this.logger.debug(`Consumed ${processed} inbox messages from SQS`);
      }
    } catch (error) {
      this.logger.error(
        "Inbox worker failed while polling messages",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
