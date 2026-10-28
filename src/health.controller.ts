import { Controller, Get } from "@nestjs/common";
import { GretterService } from "./greeter.service";

@Controller("health")
export class HealthController {
  constructor(private readonly greeter: GretterService) {}

  @Get("live")
  live() {
    return { status: "ok", greeting: this.greeter.hello() };
  }
}
