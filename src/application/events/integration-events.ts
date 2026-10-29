import { randomUUID } from "node:crypto";
import type { MoneyProps } from "../../domain/money/money";

export type LedgerDirection = "DEBIT" | "CREDIT";

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON() {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

export interface WagerTransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(
    aggregateId: string,
    data: WagerTransactionData,
    context: EventContext,
  ) {
    return new WagerTransactionProcessed({
      eventId: randomUUID(),
      aggregateId,
      ...context,
      occurredAt: new Date(),
      data,
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(
    aggregateId: string,
    data: WagerTransactionData,
    context: EventContext,
  ) {
    return new WagerTransactionRejected({
      eventId: randomUUID(),
      aggregateId,
      ...context,
      occurredAt: new Date(),
      data,
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(
    aggregateId: string,
    data: WagerTransactionData,
    context: EventContext,
  ) {
    return new WagerTransactionPendingReference({
      eventId: randomUUID(),
      aggregateId,
      ...context,
      occurredAt: new Date(),
      data,
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(
    aggregateId: string,
    data: WalletBalanceChangedData,
    context: EventContext,
  ) {
    return new WalletBalanceChanged({
      eventId: randomUUID(),
      aggregateId,
      ...context,
      occurredAt: new Date(),
      data,
    });
  }
}
