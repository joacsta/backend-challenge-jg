import { Controller, Get } from "@nestjs/common";
import { MetricsService } from "../infrastructure/observability/metrics.service";

@Controller()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get("metrics")
  async getMetrics() {
    return this.metricsService.snapshot();
  }
}
