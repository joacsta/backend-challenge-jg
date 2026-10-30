import type { WagerTransactionEntity } from "../../infrastructure/persistence/entities/wager-transaction.entity";
import type {
  EventContext,
  WagerTransactionData,
} from "../events/integration-events";
import type { SubmitWagerInput } from "./wagering-application.service";

export function eventContext(input: SubmitWagerInput): EventContext {
  return {
    correlationId:
      input.correlationId ??
      `${input.providerId}:${input.externalTransactionId}`,
    causationId: input.externalTransactionId,
  };
}

export function transactionEventData(
  transaction: WagerTransactionEntity,
): WagerTransactionData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: {
      amount: transaction.amount,
      currency: transaction.currency,
    },
    status: transaction.status,
    ...(transaction.failureCode
      ? { failureCode: transaction.failureCode }
      : {}),
  };
}
