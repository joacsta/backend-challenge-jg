import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/core";
import { GretterService } from "./greeter.service";
import { SqsTransportService } from "./infrastructure/messaging/sqs-transport.service";

@Controller("health")
export class HealthController {
  constructor(
    private readonly greeter: GretterService,
    private readonly em: EntityManager,
    private readonly sqsTransport: SqsTransportService,
  ) {}

  @Get("live")
  live() {
    return { status: "ok", greeting: this.greeter.hello() };
  }

  @Get("ready")
  async ready() {
    let postgresReady = false;
    let sqsReady = false;

    try {
      await this.em.getConnection().execute("SELECT 1");
      postgresReady = true;
    } catch {
      postgresReady = false;
    }

    try {
      sqsReady = await this.sqsTransport.probe();
    } catch {
      sqsReady = false;
    }

    const payload = {
      status: postgresReady && sqsReady ? "ok" : "degraded",
      postgres: postgresReady,
      sqs: sqsReady,
    };

    if (!postgresReady || !sqsReady) {
      throw new ServiceUnavailableException(payload);
    }

    return payload;
  }
}
