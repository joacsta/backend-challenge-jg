import { describe, expect, it } from "bun:test";
import { Money } from "../../src/domain/money/money";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from "../../src/domain/money/money.errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from", () => {
  it("normaliza duas casas decimais", () => {
    expect(brl("25").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(brl("25.5").toJSON().amount).toBe("25.50");
  });

  for (const bad of [
    "25.555",
    "1e3",
    "",
    "NaN",
    "Infinity",
    "-1.00",
    "abc",
    " 1.00",
  ]) {
    it(`rejeita amount invalido`, () => {
      expect(() => brl(bad)).toThrow(InvalidMoneyError);
    });
  }

  it("rejeita currency invalida", () => {
    expect(() => Money.from({ amount: "1.00", currency: "brl" })).toThrow(
      InvalidMoneyError,
    );
  });

  it("rejeita algo que nao seja string", () => {
    expect(() =>
      Money.from({ amount: 25 as unknown as string, currency: "BRL" }),
    ).toThrow(InvalidMoneyError);
  });
});

describe("Money arithmetic", () => {
  it("add sem erro de float point", () => {
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
  });

  it("subtrai e pode ser negativo internamente", () => {
    const result = brl("1.00").subtract(brl("2.50"));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe("-1.50");
  });

  it("imutavel", () => {
    const original = brl("10.00");
    original.add(brl("5.00"));
    expect(original.toJSON().amount).toBe("10.00");
  });

  it("mismatch de currency", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it("compara por valor", () => {
    expect(brl("10").equals(brl("10.00"))).toBe(true);
    expect(brl("10.00").equals(brl("10.01"))).toBe(false);
    expect(brl("1.00").isLessThan(brl("2.00"))).toBe(true);
  });

  it("verifica zero e aceita", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(Money.zero("BRL").toJSON().amount).toBe("0.00");
  });

  it("mantem precisao", () => {
    expect(brl("9007199254740993.01").toJSON().amount).toBe(
      "9007199254740993.01",
    );
  });
});
