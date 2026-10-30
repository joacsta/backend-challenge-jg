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
  UseGuards,
} from "@nestjs/common";
import { WageringApplicationService } from "../application/wagering/wagering-application.service";
import { ApiKeyGuard } from "../auth/api-key.guard";
import { RequireApiKey } from "../auth/require-api-key.decorator";

@Controller()
@UseGuards(ApiKeyGuard)
export class WageringController {
  constructor(
    private readonly wageringApplicationService: WageringApplicationService,
  ) {}

  @Post("wagering/transactions")
  @RequireApiKey("PROVIDER_API_KEY")
  @HttpCode(200)
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKeyHeader: string,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Headers("x-provider-id") providerIdentity: string | undefined,
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
    if (
      !providerIdentity ||
      providerIdentity !== body.providerId ||
      !this.isAllowedProvider(body.providerId)
    ) {
      throw new BadRequestException("Provider identity does not match payload");
    }
    if (correlationId && correlationId.length > 128) {
      throw new BadRequestException("Correlation ID is too long");
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
  @RequireApiKey("PROVIDER_API_KEY")
  async getTransaction(@Param("transactionId") transactionId: string) {
    return this.wageringApplicationService.findTransactionById(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  @RequireApiKey("PROVIDER_API_KEY")
  async getTransactionByProviderReference(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Headers("x-provider-id") providerIdentity: string | undefined,
  ) {
    if (
      !providerIdentity ||
      providerIdentity !== providerId ||
      !this.isAllowedProvider(providerId)
    ) {
      throw new BadRequestException("Provider identity does not match path");
    }
    return this.wageringApplicationService.findTransactionByProviderReference(
      providerId,
      externalTransactionId,
    );
  }

  private isAllowedProvider(providerId: string): boolean {
    const configuredProviders = (process.env.ALLOWED_PROVIDER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return configuredProviders.includes(providerId);
  }
}
