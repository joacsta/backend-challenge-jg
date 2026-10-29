import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { SqsInboxConsumerService } from "./sqs-inbox-consumer.service";

@Injectable()
export class InboxWorkerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(InboxWorkerService.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopping = false;

  constructor(private readonly inboxConsumer: SqsInboxConsumerService) {}

  onModuleInit() {
    if (!process.env.AWS_SQS_INBOX_URL) {
      this.logger.warn(
        "AWS_SQS_INBOX_URL not configured; inbox worker disabled.",
      );
      return;
    }

    this.start();
  }

  async onApplicationShutdown() {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
    this.logger.log("Inbox worker stopped gracefully");
  }

  private start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runPoll();
    }, 5_000);

    void this.runPoll();
  }

  private async runPoll() {
    if (this.stopping || this.inFlight) {
      return;
    }

    this.inFlight = this.pollOnce();
    try {
      await this.inFlight;
    } catch (error) {
      this.logger.error(
        "Inbox worker failed while polling messages",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.inFlight = undefined;
    }
  }

  private async pollOnce() {
    const processed = await this.inboxConsumer.pollOnce(10);
    if (processed > 0) {
      this.logger.debug(`Consumed ${processed} inbox messages from SQS`);
    }
  }
}
