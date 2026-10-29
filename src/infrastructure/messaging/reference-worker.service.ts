import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { WageringApplicationService } from "../../application/wagering/wagering-application.service";

@Injectable()
export class ReferenceWorkerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(ReferenceWorkerService.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly wageringApplicationService: WageringApplicationService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.runPoll();
    }, 5_000);
    void this.runPoll();
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
    this.logger.log("Reference worker stopped gracefully");
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
        "Reference worker failed",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.inFlight = undefined;
    }
  }

  private async pollOnce() {
    const processed =
      await this.wageringApplicationService.processPendingReferences();
    if (processed > 0) {
      this.logger.debug(`Processed ${processed} pending references`);
    }
  }
}
