import { MikroORM } from "@mikro-orm/core";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  WageringApplicationService,
  type SubmitWagerInput,
} from "../../src/application/wagering/wagering-application.service";
import { WalletApplicationService } from "../../src/application/wallet/wallet-application.service";
import { WalletEntity } from "../../src/infrastructure/persistence/entities/wallet.entity";
import { WalletLedgerEntryEntity } from "../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { WagerTransactionEntity } from "../../src/infrastructure/persistence/entities/wager-transaction.entity";
import { OutboxMessageEntity } from "../../src/infrastructure/persistence/entities/outbox-message.entity";
import { MetricsService } from "../../src/infrastructure/observability/metrics.service";
import ormConfig from "../../src/infrastructure/persistence/mikro-orm.config";

const captureError = async (
  operation: () => Promise<unknown>,
): Promise<unknown> => {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
};

const eventTransactionIds = (events: OutboxMessageEntity[]): string[] =>
  events.map(
    (event) =>
      (event.payload as { data?: { transactionId?: string } }).data
        ?.transactionId ?? "",
  );

describe("caracterização do WageringApplicationService", () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(ormConfig);
    await orm.migrator.up();
    await orm.em
      .getConnection()
      .execute(
        "ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ledger_no_update_delete",
      );
    await orm.em
      .getConnection()
      .execute(
        "ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ledger_no_truncate",
      );
    await orm.em.getConnection().execute("DELETE FROM wallet_ledger_entries");
    await orm.em.getConnection().execute("DELETE FROM wager_transactions");
    await orm.em.getConnection().execute("DELETE FROM outbox_messages");
    await orm.em.getConnection().execute("DELETE FROM inbox_messages");
    await orm.em.getConnection().execute("DELETE FROM wallets");
  });

  afterAll(async () => {
    await orm.close();
  });

  const service = (metrics?: MetricsService) =>
    new WageringApplicationService(orm.em.fork(), metrics);

  const createWallet = (playerId: string, amount = "100.00") =>
    new WalletApplicationService(orm.em.fork()).createWallet({
      playerId,
      initialBalance: { amount, currency: "BRL" },
    });

  const wager = (
    overrides: Partial<SubmitWagerInput> = {},
  ): SubmitWagerInput => ({
    providerId: "provider-characterization",
    externalTransactionId: randomUUID(),
    playerId: randomUUID(),
    walletId: randomUUID(),
    roundId: "round-characterization",
    gameId: "game-characterization",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  });

  test("LOSS é processado sem mover saldo e sem lançamento no ledger", async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId);
    const input = wager({
      providerId: "provider-char-loss",
      playerId,
      walletId: wallet.id,
      roundId: "round-loss",
      kind: "LOSS",
    });

    const result = await service().submitWager(
      input,
      `${input.providerId}:${input.externalTransactionId}`,
    );

    expect(result.status).toBe("PROCESSED");
    expect(result.balance.amount).toBe("100.00");
    expect(result.idempotentReplay).toBe(false);

    const stored = await orm.em
      .fork()
      .findOne(WagerTransactionEntity, { id: result.transactionId });
    expect(stored?.status).toBe("PROCESSED");
    expect(stored?.observedBalance).toBe("100.00");

    const ledger = await orm.em
      .fork()
      .find(WalletLedgerEntryEntity, { walletId: wallet.id });
    expect(ledger.length).toBe(1);
    expect(
      ledger.every((entry) => entry.transactionId !== result.transactionId),
    ).toBe(true);

    const processedEvents = await orm.em.fork().find(OutboxMessageEntity, {
      aggregateId: wallet.id,
      eventType: "WagerTransactionProcessed",
    });
    expect(processedEvents.length).toBe(2);
    expect(eventTransactionIds(processedEvents)).toContain(
      result.transactionId,
    );
  });

  test("referência inválida rejeita com o código atual e mantém o saldo", async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId);
    const providerId = "provider-char-reference";

    const bet = await service().submitWager(
      wager({
        providerId,
        playerId,
        walletId: wallet.id,
        roundId: "round-reference",
        externalTransactionId: "bet-reference",
      }),
      `${providerId}:bet-reference`,
    );
    expect(bet.status).toBe("PROCESSED");

    const win = await service().submitWager(
      wager({
        providerId,
        playerId,
        walletId: wallet.id,
        roundId: "round-reference",
        kind: "WIN",
        externalTransactionId: "win-reference",
        money: { amount: "10.00", currency: "BRL" },
      }),
      `${providerId}:win-reference`,
    );
    expect(win.status).toBe("PROCESSED");

    const amountMismatch = await service().submitWager(
      wager({
        providerId,
        playerId,
        walletId: wallet.id,
        roundId: "round-reference",
        kind: "REFUND",
        externalTransactionId: "refund-amount-mismatch",
        referenceExternalTransactionId: "bet-reference",
        money: { amount: "24.00", currency: "BRL" },
      }),
      `${providerId}:refund-amount-mismatch`,
    );

    const invalidKind = await service().submitWager(
      wager({
        providerId,
        playerId,
        walletId: wallet.id,
        roundId: "round-reference",
        kind: "REFUND",
        externalTransactionId: "refund-invalid-kind",
        referenceExternalTransactionId: "win-reference",
        money: { amount: "10.00", currency: "BRL" },
      }),
      `${providerId}:refund-invalid-kind`,
    );

    const roundMismatch = await service().submitWager(
      wager({
        providerId,
        playerId,
        walletId: wallet.id,
        roundId: "round-other",
        kind: "REFUND",
        externalTransactionId: "refund-round-mismatch",
        referenceExternalTransactionId: "bet-reference",
      }),
      `${providerId}:refund-round-mismatch`,
    );

    for (const rejected of [amountMismatch, invalidKind, roundMismatch]) {
      expect(rejected.status).toBe("REJECTED");
      expect(rejected.balance.amount).toBe("85.00");
      expect(rejected.idempotentReplay).toBe(false);
    }

    const failureCodes = await Promise.all(
      [amountMismatch, invalidKind, roundMismatch].map(async (rejected) => {
        const stored = await orm.em
          .fork()
          .findOne(WagerTransactionEntity, {
            id: rejected.transactionId,
          });
        return stored?.failureCode;
      }),
    );
    expect(failureCodes.join(",")).toBe(
      "REFERENCE_AMOUNT_MISMATCH,INVALID_REFERENCE_KIND,REFERENCE_MISMATCH",
    );

    const rejectedEvents = await orm.em.fork().find(OutboxMessageEntity, {
      aggregateId: wallet.id,
      eventType: "WagerTransactionRejected",
    });
    expect(rejectedEvents.length).toBe(3);

    const ledger = await orm.em
      .fork()
      .find(WalletLedgerEntryEntity, { walletId: wallet.id });
    expect(ledger.length).toBe(3);
  });

  test("referência ausente esgota as tentativas e vira REJECTED", async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId);
    const providerId = "provider-char-attempts";
    const input = wager({
      providerId,
      playerId,
      walletId: wallet.id,
      roundId: "round-attempts",
      kind: "REFUND",
      externalTransactionId: "refund-exhausted",
      referenceExternalTransactionId: "never-arrives",
      money: { amount: "10.00", currency: "BRL" },
    });
    const key = `${providerId}:refund-exhausted`;

    const first = await service().submitWager(input, key);
    expect(first.status).toBe("PENDING_REFERENCE");
    expect(first.balance.amount).toBe("100.00");

    let latest = first;
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await orm.em.nativeUpdate(
        WagerTransactionEntity,
        { id: first.transactionId },
        { nextAttemptAt: new Date(0) },
      );
      latest = await service().submitWager(input, key);
    }

    expect(latest.status).toBe("REJECTED");
    expect(latest.balance.amount).toBe("100.00");

    const stored = await orm.em
      .fork()
      .findOne(WagerTransactionEntity, { id: first.transactionId });
    expect(stored?.attempts).toBe(5);
    expect(stored?.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(stored?.observedBalance).toBe("100.00");

    const pendingEvents = await orm.em.fork().find(OutboxMessageEntity, {
      aggregateId: wallet.id,
      eventType: "WagerTransactionPendingReference",
    });
    const rejectedEvents = await orm.em.fork().find(OutboxMessageEntity, {
      aggregateId: wallet.id,
      eventType: "WagerTransactionRejected",
    });
    expect(pendingEvents.length).toBe(4);
    expect(rejectedEvents.length).toBe(1);
  });

  test("replay de transação REJECTED devolve o mesmo status e saldo", async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId);
    const providerId = "provider-char-replay-rejected";
    const input = wager({
      providerId,
      playerId,
      walletId: wallet.id,
      roundId: "round-replay-rejected",
      externalTransactionId: "bet-insufficient",
      money: { amount: "200.00", currency: "BRL" },
    });
    const key = `${providerId}:bet-insufficient`;

    const first = await service().submitWager(input, key);
    const replay = await service().submitWager(input, key);

    expect(first.status).toBe("REJECTED");
    expect(first.idempotentReplay).toBe(false);
    expect(replay.status).toBe("REJECTED");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe("100.00");

    const stored = await orm.em
      .fork()
      .findOne(WagerTransactionEntity, { id: first.transactionId });
    expect(stored?.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(stored?.attempts).toBe(0);
    expect(stored?.observedBalance).toBe("100.00");

    const ledger = await orm.em
      .fork()
      .find(WalletLedgerEntryEntity, { walletId: wallet.id });
    expect(ledger.length).toBe(1);

    const rejectedEvents = await orm.em.fork().find(OutboxMessageEntity, {
      aggregateId: wallet.id,
      eventType: "WagerTransactionRejected",
    });
    expect(rejectedEvents.length).toBe(1);
  });

  test("findTransactionById e findTransactionByProviderReference mantêm o formato", async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId);
    const providerId = "provider-char-find";
    const input = wager({
      providerId,
      playerId,
      walletId: wallet.id,
      roundId: "round-find",
      externalTransactionId: "bet-find",
    });

    const submitted = await service().submitWager(
      input,
      `${providerId}:bet-find`,
    );
    const byId = await service().findTransactionById(
      submitted.transactionId,
    );
    const byReference = await service().findTransactionByProviderReference(
      providerId,
      "bet-find",
    );

    expect(Object.keys(byId).sort().join(",")).toBe(
      [
        "amount",
        "createdAt",
        "externalTransactionId",
        "failureCode",
        "gameId",
        "id",
        "kind",
        "observedBalance",
        "playerId",
        "processedAt",
        "providerId",
        "roundId",
        "status",
        "walletId",
      ].join(","),
    );
    expect(byId.id).toBe(submitted.transactionId);
    expect(byId.providerId).toBe(providerId);
    expect(byId.externalTransactionId).toBe("bet-find");
    expect(byId.walletId).toBe(wallet.id);
    expect(byId.playerId).toBe(playerId);
    expect(byId.roundId).toBe("round-find");
    expect(byId.gameId).toBe("game-characterization");
    expect(byId.kind).toBe("BET");
    expect(byId.status).toBe("PROCESSED");
    expect(byId.amount.amount).toBe("25.00");
    expect(byId.amount.currency).toBe("BRL");
    expect(byId.observedBalance?.amount).toBe("75.00");
    expect(byId.observedBalance?.currency).toBe("BRL");
    expect(byId.failureCode).toBeFalsy();
    expect(byId.createdAt instanceof Date).toBe(true);
    expect(byId.processedAt instanceof Date).toBe(true);
    expect(byReference.id).toBe(byId.id);
    expect(byReference.status).toBe(byId.status);

    const missingById = await captureError(() =>
      service().findTransactionById(randomUUID()),
    );
    const missingByReference = await captureError(() =>
      service().findTransactionByProviderReference(providerId, "absent"),
    );
    expect(missingById instanceof NotFoundException).toBe(true);
    expect(missingByReference instanceof NotFoundException).toBe(true);
  });

  test("métricas observáveis permanecem as mesmas", async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId);
    const metrics = new MetricsService();
    const providerId = "provider-char-metrics";
    const input = wager({
      providerId,
      playerId,
      walletId: wallet.id,
      roundId: "round-metrics",
      externalTransactionId: "bet-metrics",
    });
    const key = `${providerId}:bet-metrics`;

    await service(metrics).submitWager(input, key);
    await service(metrics).submitWager(input, key);

    const conflict = await captureError(() =>
      service(metrics).submitWager(
        { ...input, money: { amount: "30.00", currency: "BRL" } },
        key,
      ),
    );
    expect(conflict instanceof ConflictException).toBe(true);

    const insufficient = await service(metrics).submitWager(
      wager({
        providerId,
        playerId,
        walletId: wallet.id,
        roundId: "round-metrics",
        externalTransactionId: "bet-metrics-insufficient",
        money: { amount: "1000.00", currency: "BRL" },
      }),
      `${providerId}:bet-metrics-insufficient`,
    );
    expect(insufficient.status).toBe("REJECTED");

    const snapshot = metrics.snapshot();
    expect(snapshot["wager.transaction.processed"]).toBe(1);
    expect(snapshot["wager.transaction.rejected"]).toBe(1);
    expect(snapshot["wager.processing_latency_ms.count"]).toBe(2);
    expect(snapshot["wager.status.processed"]).toBe(1);
    expect(snapshot["wager.status.rejected"]).toBe(1);
    expect(snapshot["idempotency.replay"]).toBe(1);
    expect(snapshot["idempotency.payload_conflict"]).toBe(1);
  });
});
