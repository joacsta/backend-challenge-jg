import { Money, type MoneyProps } from "../money/money";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export type FailureCode =
  | "INSUFFICIENT_FUNDS"
  | "INVALID_REFERENCE"
  | "REFERENCE_NOT_FOUND"
  | "REFERENCE_MISMATCH"
  | "INVALID_REFERENCE_KIND"
  | "REFERENCE_AMOUNT_MISMATCH"
  | "ALREADY_REVERSED"
  | "REVERSAL_INSUFFICIENT_FUNDS"
  | "INVALID_MONEY"
  | "IDEMPOTENCY_CONFLICT"
  | "RULE_REJECTION"
  | "INFRASTRUCTURE_ERROR";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date | string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date | string;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback
    ) {
      if (!props.referenceExternalTransactionId) {
        throw new Error(
          "Refund and rollback require referenceExternalTransactionId",
        );
      }
    }

    if (
      props.kind === WagerTransactionKind.Bet ||
      props.kind === WagerTransactionKind.Opening
    ) {
      if (props.referenceExternalTransactionId) {
        throw new Error("Bet and opening cannot carry a reference");
      }
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      Money.from(props.money),
      props.referenceExternalTransactionId,
      new Date(),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.money),
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt) : undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    if (this.isTerminal()) {
      throw new Error("Cannot transition a terminal transaction");
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    if (this.isTerminal()) {
      throw new Error("Cannot transition a terminal transaction");
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    if (this.isTerminal()) {
      throw new Error("Cannot transition a terminal transaction");
    }

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = new Date();
  }

  fail(code: FailureCode): void {
    if (this.isTerminal()) {
      throw new Error("Cannot transition a terminal transaction");
    }

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = new Date();
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return (
      this.kind === WagerTransactionKind.Opening ||
      this.kind === WagerTransactionKind.Bet ||
      this.kind === WagerTransactionKind.Win ||
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): "DEBIT" | "CREDIT" {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return "DEBIT";
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return "CREDIT";
      case WagerTransactionKind.Rollback:
        if (!reference) {
          return "CREDIT";
        }

        return reference.kind === WagerTransactionKind.Bet ||
          reference.kind === WagerTransactionKind.Refund
          ? "CREDIT"
          : "DEBIT";
      default:
        return "CREDIT";
    }
  }
}
