import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import ormConfig from "./infrastructure/persistence/mikro-orm.config";
import { HealthController } from "./health.controller";
import { GretterService } from "./greeter.service";
import { WalletController } from "./controllers/wallet.controller";
import { WageringController } from "./controllers/wagering.controller";
import { QueueController } from "./controllers/queue.controller";
import { WalletApplicationService } from "./application/wallet/wallet-application.service";
import { WageringApplicationService } from "./application/wagering/wagering-application.service";
import { InboxMessageService } from "./infrastructure/messaging/inbox-message.service";
import { OutboxProcessorService } from "./infrastructure/messaging/outbox-processor.service";
import { OutboxWorkerService } from "./infrastructure/messaging/outbox-worker.service";
import { InboxWorkerService } from "./infrastructure/messaging/inbox-worker.service";
import { SqsInboxConsumerService } from "./infrastructure/messaging/sqs-inbox-consumer.service";
import { SqsTransportService } from "./infrastructure/messaging/sqs-transport.service";

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig)],
  controllers: [HealthController, WalletController, WageringController, QueueController],
  providers: [
    GretterService,
    WalletApplicationService,
    WageringApplicationService,
    InboxMessageService,
    OutboxProcessorService,
    OutboxWorkerService,
    SqsTransportService,
    SqsInboxConsumerService,
    InboxWorkerService,
  ],
})
export class AppModule {}
