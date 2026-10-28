export class InsufficientFundsError extends Error {
  constructor(balance: string, requested: string, currency: string) {
    super(
      `Insufficient funds: balance ${balance} ${currency}, requested ${requested} ${currency}`,
    );
    this.name = "InsufficientFundsError";
  }
}

export class WalletCurrencyMismatchError extends Error {
  constructor(left: string, right: string) {
    super(`Wallet currency mismatch: ${left} vs ${right}`);
    this.name = "WalletCurrencyMismatchError";
  }
}

export class InvalidWalletStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWalletStateError";
  }
}
