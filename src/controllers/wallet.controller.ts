import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { WalletApplicationService } from "../application/wallet/wallet-application.service";
import { ApiKeyGuard } from "../auth/api-key.guard";
import { RequireApiKey } from "../auth/require-api-key.decorator";

@Controller("wallets")
@UseGuards(ApiKeyGuard)
export class WalletController {
  constructor(
    private readonly walletApplicationService: WalletApplicationService,
  ) {}

  @Post()
  @RequireApiKey("ADMIN_API_KEY")
  async createWallet(
    @Body()
    body: {
      playerId: string;
      initialBalance: { amount: string; currency: string };
    },
  ) {
    return this.walletApplicationService.createWallet({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
    });
  }

  @Get(":walletId")
  @RequireApiKey("API_KEY")
  async getWallet(@Param("walletId") walletId: string) {
    return this.walletApplicationService.findById(walletId);
  }

  @Get(":walletId/ledger")
  @RequireApiKey("API_KEY")
  async getLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.walletApplicationService.findLedger(
      walletId,
      cursor,
      Number(limit ?? 50),
    );
  }

  @Post(":walletId/reconciliation")
  @RequireApiKey("ADMIN_API_KEY")
  async reconcileWallet(
    @Param("walletId") walletId: string,
    @Body()
    body: {
      storedBalance: { amount: string; currency: string };
      calculatedBalance: { amount: string; currency: string };
    },
  ) {
    return this.walletApplicationService.reconcileWallet(
      walletId,
      body.storedBalance,
      body.calculatedBalance,
    );
  }
}
