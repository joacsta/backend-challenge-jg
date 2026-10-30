import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { OutboxProcessorService } from "./outbox-processor.service";
import { SqsTransportService } from "./sqs-transport.service";

@Injectable()
export class OutboxWorkerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxWorkerService.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly outboxProcessor: OutboxProcessorService,
    private readonly sqsTransport: SqsTransportService,
  ) {}

  onModuleInit() {
    if (!process.env.AWS_SQS_OUTBOX_URL) {
      this.logger.warn(
        "AWS_SQS_OUTBOX_URL not configured; outbox worker disabled.",
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
    this.logger.log("Outbox worker stopped gracefully");
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
        "Outbox worker failed while publishing pending messages",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.inFlight = undefined;
    }
  }

  private async pollOnce() {
    if (!this.sqsTransport) {
      return;
    }

    const published = await this.outboxProcessor.publishNextPending(25);
    if (published.length > 0) {
      this.logger.debug(`Published ${published.length} pending outbox events`);
    }
  }
}
