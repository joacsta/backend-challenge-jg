import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { WalletApplicationService } from "../application/wallet/wallet-application.service";

@Controller("wallets")
export class WalletController {
  constructor(private readonly walletApplicationService: WalletApplicationService) {}

  @Post()
  async createWallet(@Body() body: { playerId: string; initialBalance: { amount: string; currency: string } }) {
    return this.walletApplicationService.createWallet({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
    });
  }

  @Get(":walletId")
  async getWallet(@Param("walletId") walletId: string) {
    return this.walletApplicationService.findById(walletId);
  }
}
