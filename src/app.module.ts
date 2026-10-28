import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { GretterService } from "./greeter.service";

@Module({ controllers: [HealthController], providers: [GretterService] })
export class AppModule {}
