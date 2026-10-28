import { Body, Controller, Headers, Param, Post } from "@nestjs/common";
import { WageringApplicationService } from "../application/wagering/wagering-application.service";

@Controller("wagering")
export class WageringController {
  constructor(private readonly wageringApplicationService: WageringApplicationService) {}

  @Post("transactions")
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKeyHeader: string,
    @Body() body: {
      providerId: string;
      externalTransactionId: string;
      playerId: string;
      walletId: string;
      roundId: string;
      gameId: string;
      kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
      money: { amount: string; currency: string };
      referenceExternalTransactionId?: string;
    },
  ) {
    return this.wageringApplicationService.submitWager(body, idempotencyKeyHeader);
  }
}
