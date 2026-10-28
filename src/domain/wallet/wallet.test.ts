import { describe, expect, test } from "bun:test";
import { Money } from "../money/money";
import { InsufficientFundsError } from "./wallet.errors";
import { Wallet } from "./wallet";

describe("Money", () => {
  test("creates valid decimal values and preserves two decimal places", () => {
    const value = Money.from({ amount: "25.50", currency: "BRL" });

    expect(value.toJSON()).toEqual({ amount: "25.50", currency: "BRL" });
    expect(value.toString()).toBe("25.50 BRL");
  });

  test("rejects invalid decimal input", () => {
    expect(() => Money.from({ amount: "25.555", currency: "BRL" })).toThrow();
    expect(() => Money.from({ amount: "-10.00", currency: "BRL" })).toThrow();
    expect(() => Money.from({ amount: "1e3", currency: "BRL" })).toThrow();
  });

  test("adds and subtracts with same currency", () => {
    const a = Money.from({ amount: "100.00", currency: "BRL" });
    const b = Money.from({ amount: "25.50", currency: "BRL" });

    expect(a.add(b).toJSON()).toEqual({ amount: "125.50", currency: "BRL" });
    expect(a.subtract(b).toJSON()).toEqual({ amount: "74.50", currency: "BRL" });
  });
});

describe("Wallet", () => {
  test("opens wallet with initial balance and version starts at 1", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
  });

  test("credit and debit update balance and version", () => {
    const wallet = Wallet.open({
      id: "wallet-2",
      playerId: "player-2",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    wallet.credit(Money.from({ amount: "25.00", currency: "BRL" }));
    expect(wallet.balance.toJSON()).toEqual({ amount: "125.00", currency: "BRL" });
    expect(wallet.version).toBe(2);

    wallet.debit(Money.from({ amount: "20.00", currency: "BRL" }));
    expect(wallet.balance.toJSON()).toEqual({ amount: "105.00", currency: "BRL" });
    expect(wallet.version).toBe(3);
  });

  test("rejects negative balance after debit", () => {
    const wallet = Wallet.open({
      id: "wallet-3",
      playerId: "player-3",
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
    });

    expect(() => {
      wallet.debit(Money.from({ amount: "20.00", currency: "BRL" }));
    }).toThrow(InsufficientFundsError);
  });
});
