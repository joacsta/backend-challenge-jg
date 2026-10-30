import { Money, type MoneyProps } from "../../domain/money/money";
import { rollbackDirection } from "./wagering-reference-policy";

export interface BalanceMovement {
  direction: "DEBIT" | "CREDIT";
  before: Money;
  after: Money;
}

export interface BalanceRejection {
  failureCode: "INSUFFICIENT_FUNDS" | "REVERSAL_INSUFFICIENT_FUNDS";
}

export function creditMovement(
  balance: MoneyProps,
  amount: Money,
): BalanceMovement {
  const before = Money.from(balance);
  return {
    direction: "CREDIT",
    before,
    after: before.add(amount),
  };
}

export function betMovement(
  balance: MoneyProps,
  amount: Money,
): BalanceMovement | BalanceRejection {
  const before = Money.from(balance);
  if (before.isLessThan(amount)) {
    return { failureCode: "INSUFFICIENT_FUNDS" };
  }

  return {
    direction: "DEBIT",
    before,
    after: before.subtract(amount),
  };
}

export function rollbackMovement(
  balance: MoneyProps,
  amount: Money,
  referenceKind: string,
): BalanceMovement | BalanceRejection {
  const before = Money.from(balance);
  const direction = rollbackDirection(referenceKind);
  const after =
    direction === "CREDIT" ? before.add(amount) : before.subtract(amount);

  if (after.isNegative()) {
    return { failureCode: "REVERSAL_INSUFFICIENT_FUNDS" };
  }

  return { direction, before, after };
}
