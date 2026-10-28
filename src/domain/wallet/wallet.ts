import { Money, type MoneyProps } from "../money/money";
import {
  InsufficientFundsError,
  WalletCurrencyMismatchError,
} from "./wallet.errors";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(),
      new Date(),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canAfford(amount: Money): boolean {
    this.assertSameCurrency(amount);
    return !this._balance.subtract(amount).isNegative();
  }

  credit(amount: Money): Wallet {
    this.assertSameCurrency(amount);
    this._balance = this._balance.add(amount);
    this._version += 1;
    this._updatedAt = new Date();
    return this;
  }

  debit(amount: Money): Wallet {
    this.assertSameCurrency(amount);
    const next = this._balance.subtract(amount);

    if (next.isNegative()) {
      throw new InsufficientFundsError(
        this._balance.toString(),
        amount.toString(),
        this.currency,
      );
    }

    this._balance = next;
    this._version += 1;
    this._updatedAt = new Date();
    return this;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new WalletCurrencyMismatchError(this.currency, other.currency);
    }
  }
}
