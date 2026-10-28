import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import ormConfig from "./infrastructure/persistence/mikro-orm.config";
import { HealthController } from "./health.controller";
import { GretterService } from "./greeter.service";
import { WalletController } from "./controllers/wallet.controller";
import { WageringController } from "./controllers/wagering.controller";
import { WalletApplicationService } from "./application/wallet/wallet-application.service";
import { WageringApplicationService } from "./application/wagering/wagering-application.service";

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig)],
  controllers: [HealthController, WalletController, WageringController],
  providers: [GretterService, WalletApplicationService, WageringApplicationService],
})
export class AppModule {}
