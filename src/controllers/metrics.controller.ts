import { Controller, Get } from "@nestjs/common";
import { MetricsService } from "../infrastructure/observability/metrics.service";

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get("metrics")
  async metrics() {
    return this.metrics.snapshot();
  }
}
