import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Param,
  Post,
} from "@nestjs/common";
import { WageringApplicationService } from "../application/wagering/wagering-application.service";

@Controller()
export class WageringController {
  constructor(
    private readonly wageringApplicationService: WageringApplicationService,
  ) {}

  @Post("wagering/transactions")
  @HttpCode(200)
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKeyHeader: string,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Body()
    body: {
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

    const result = await this.wageringApplicationService.submitWager(
      { ...body, correlationId },
      idempotencyKeyHeader,
    );

    if (result.status === "PENDING_REFERENCE") {
      throw new HttpException(result, 202);
    }

    if (result.status === "REJECTED") {
      throw new HttpException(result, 422);
    }

    return result;
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
    return this.wageringApplicationService.findTransactionByProviderReference(
      providerId,
      externalTransactionId,
    );
  }
}
