import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { WalletApplicationService } from "../application/wallet/wallet-application.service";

@Controller("wallets")
export class WalletController {
  constructor(
    private readonly walletApplicationService: WalletApplicationService,
  ) {}

  @Post()
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
  async getWallet(@Param("walletId") walletId: string) {
    return this.walletApplicationService.findById(walletId);
  }

  @Get(":walletId/ledger")
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
