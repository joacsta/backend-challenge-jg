import { Money } from "../../domain/money/money";
import type { WalletEntity } from "../../infrastructure/persistence/entities/wallet.entity";
import type { WagerTransactionEntity } from "../../infrastructure/persistence/entities/wager-transaction.entity";
import type { SubmitWagerInput } from "./wagering-application.service";

export type ReferenceFailure =
  | "INVALID_REFERENCE"
  | "REFERENCE_MISMATCH"
  | "INVALID_REFERENCE_KIND"
  | "REFERENCE_AMOUNT_MISMATCH";

export function isReferenceAttemptDue(
  transaction: WagerTransactionEntity,
): boolean {
  return !transaction.nextAttemptAt || transaction.nextAttemptAt <= new Date();
}

export function validateReference(
  input: SubmitWagerInput,
  amount: Money,
  wallet: WalletEntity,
  reference: WagerTransactionEntity,
): ReferenceFailure | undefined {
  if (
    reference.status !== "PROCESSED" ||
    reference.providerId !== input.providerId ||
    reference.playerId !== wallet.playerId ||
    reference.walletId !== wallet.id ||
    reference.roundId !== input.roundId ||
    reference.currency !== wallet.currency
  ) {
    return "REFERENCE_MISMATCH";
  }

  if (
    (input.kind === "REFUND" && reference.kind !== "BET") ||
    (input.kind === "ROLLBACK" &&
      !["BET", "WIN", "REFUND"].includes(reference.kind))
  ) {
    return "INVALID_REFERENCE_KIND";
  }

  if (
    Money.from({
      amount: reference.amount,
      currency: reference.currency,
    }).toJSON().amount !== amount.toJSON().amount
  ) {
    return "REFERENCE_AMOUNT_MISMATCH";
  }

  return undefined;
}

export function rollbackDirection(referenceKind: string): "DEBIT" | "CREDIT" {
  return referenceKind === "BET" || referenceKind === "REFUND"
    ? "CREDIT"
    : "DEBIT";
}

export function nextReferenceAttempt(now: Date, attempts: number): Date {
  const delay = Math.min(30_000 * 2 ** attempts, 300_000);
  return new Date(now.getTime() + delay);
}

export function maxReferenceAttempts(): number {
  return Number(process.env.WAGER_REFERENCE_MAX_ATTEMPTS ?? "5");
}
