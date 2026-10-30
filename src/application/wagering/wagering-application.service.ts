import { EntityManager } from "@mikro-orm/core";
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import {
  makePayloadHash as hashPayload,
  payloadForHash,
  replayResult,
  resolveIdempotency,
} from "./wagering-idempotency";
import {
  findPendingReferences,
  findTransactionByExternalReference,
  findTransactionByIdempotencyKey,
  findTransactionEntityById,
  isLockConflict,
  uniqueConstraintName,
} from "./wagering-transaction-store";
import { processWagerTransaction } from "./wagering-transaction-pipeline";

export interface SubmitWagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export interface SubmitWagerResult {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
}

const REPLAYABLE_UNIQUE_CONSTRAINTS = new Set([
  "wt_idempotency_uq",
  "wt_external_uq",
  "ledger_one_entry_per_tx_uq",
]);

@Injectable()
export class WageringApplicationService {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService = new MetricsService(),
    private readonly logger: StructuredLoggerService = new StructuredLoggerService(),
  ) {}

  async findTransactionById(transactionId: string) {
    const transaction = await findTransactionEntityById(this.em, transactionId);
    if (!transaction) {
      throw new NotFoundException("Transaction not found");
    }

    return {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: { amount: transaction.amount, currency: transaction.currency },
      status: transaction.status,
      failureCode: transaction.failureCode,
      observedBalance: transaction.observedBalance
        ? {
            amount: transaction.observedBalance,
            currency: transaction.currency,
          }
        : null,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt,
    };
  }

  async findTransactionByProviderReference(
    providerId: string,
    externalTransactionId: string,
  ) {
    const transaction = await findTransactionByExternalReference(
      this.em,
      providerId,
      externalTransactionId,
    );

    if (!transaction) {
      throw new NotFoundException(
        "Transaction not found for provider reference",
      );
    }

    return this.findTransactionById(transaction.id);
  }

  async submitWager(
    input: SubmitWagerInput,
    idempotencyKeyHeader?: string,
    transactionManager?: EntityManager,
  ) {
    const startedAt = Date.now();
    const idempotencyKey =
      idempotencyKeyHeader ??
      `${input.providerId}:${input.externalTransactionId}`;

    const payloadHash = hashPayload(payloadForHash(input));

    const existingByKey = await findTransactionByIdempotencyKey(
      this.em,
      idempotencyKey,
    );

    const existingByExternalId = await findTransactionByExternalReference(
      this.em,
      input.providerId,
      input.externalTransactionId,
    );

    const preCheck = resolveIdempotency({
      existingByKey,
      existingByExternalId,
      idempotencyKey,
      payloadHash,
      input,
      metrics: this.metrics,
      logger: this.logger,
    });
    if (preCheck.action === "replay") {
      return replayResult(preCheck.existing);
    }

    let result: SubmitWagerResult;
    try {
      if (transactionManager) {
        result = await processWagerTransaction({
          em: transactionManager,
          input,
          idempotencyKey,
          payloadHash,
          metrics: this.metrics,
          logger: this.logger,
        });
      } else {
        result = await this.em.transactional((tx) =>
          processWagerTransaction({
            em: tx,
            input,
            idempotencyKey,
            payloadHash,
            metrics: this.metrics,
            logger: this.logger,
          }),
        );
      }
    } catch (error) {
      if (isLockConflict(error)) {
        this.metrics.increment("wallet.lock_conflict");
      }

      const constraint = uniqueConstraintName(error);
      if (constraint === "wt_single_reversal_uq") {
        throw new ConflictException("Transaction already reversed");
      }

      if (constraint && !transactionManager) {
        const recovered = await this.recoverFromUniqueViolation(
          input,
          idempotencyKey,
          payloadHash,
          constraint,
        );
        if (recovered) {
          this.metrics.observe(
            "wager.processing_latency_ms",
            Date.now() - startedAt,
          );
          this.metrics.increment(
            `wager.status.${recovered.status.toLowerCase()}`,
          );
          return recovered;
        }
      }

      throw error;
    }

    this.metrics.observe("wager.processing_latency_ms", Date.now() - startedAt);
    this.metrics.increment(`wager.status.${result!.status.toLowerCase()}`);
    return result!;
  }

  private async recoverFromUniqueViolation(
    input: SubmitWagerInput,
    idempotencyKey: string,
    payloadHash: string,
    constraint: string,
  ): Promise<SubmitWagerResult | undefined> {
    if (!REPLAYABLE_UNIQUE_CONSTRAINTS.has(constraint)) {
      return undefined;
    }

    const reader = this.em.fork();
    const existingByKey = await findTransactionByIdempotencyKey(
      reader,
      idempotencyKey,
    );
    const existingByExternalId = await findTransactionByExternalReference(
      reader,
      input.providerId,
      input.externalTransactionId,
    );

    const recovered = resolveIdempotency({
      existingByKey,
      existingByExternalId,
      idempotencyKey,
      payloadHash,
      input,
      replayOnly: true,
      metrics: this.metrics,
      logger: this.logger,
    });
    if (recovered.action === "replay") {
      return replayResult(recovered.existing);
    }

    return undefined;
  }

  async processPendingReferences(limit = 25): Promise<number> {
    const now = new Date();
    const workerEm = this.em.fork();
    const pending = await findPendingReferences(workerEm, limit);
    const due = pending.filter(
      (transaction) =>
        !transaction.nextAttemptAt || transaction.nextAttemptAt <= now,
    );

    for (const transaction of due) {
      await workerEm.transactional((transactionEm) =>
        this.submitWager(
          {
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            playerId: transaction.playerId,
            walletId: transaction.walletId,
            roundId: transaction.roundId,
            gameId: transaction.gameId,
            kind: transaction.kind as SubmitWagerInput["kind"],
            money: {
              amount: transaction.amount,
              currency: transaction.currency,
            },
            referenceExternalTransactionId:
              transaction.referenceExternalTransactionId ?? undefined,
            correlationId: transaction.idempotencyKey,
          },
          transaction.idempotencyKey,
          transactionEm,
        ),
      );
    }

    return due.length;
  }

  makePayloadHash(payload: Record<string, unknown>): string {
    return hashPayload(payload);
  }
}
