import { BadRequestException, Body, Controller, Get, Headers, Param, Post } from "@nestjs/common";
import { WageringApplicationService } from "../application/wagering/wagering-application.service";

@Controller()
export class WageringController {
  constructor(private readonly wageringApplicationService: WageringApplicationService) {}

  @Post("wagering/transactions")
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKeyHeader?: string,
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
    if (!idempotencyKeyHeader) {
      throw new BadRequestException("Idempotency-Key header is required");
    }

    return this.wageringApplicationService.submitWager(body, idempotencyKeyHeader);
  }

  @Get("wagering/transactions/:transactionId")
  async getTransaction(@Param("transactionId") transactionId: string) {
    return this.wageringApplicationService.findTransactionById(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getTransactionByProviderReference(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.wageringApplicationService.findTransactionByProviderReference(providerId, externalTransactionId);
  }
}
