import { MikroORM } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { WageringApplicationService } from "../../src/application/wagering/wagering-application.service";
import { WalletApplicationService } from "../../src/application/wallet/wallet-application.service";
import { WalletEntity } from "../../src/infrastructure/persistence/entities/wallet.entity";
import { WalletLedgerEntryEntity } from "../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { WagerTransactionEntity } from "../../src/infrastructure/persistence/entities/wager-transaction.entity";
import ormConfig from "../../src/infrastructure/persistence/mikro-orm.config";

describe("hot wallet concurrency", () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(ormConfig);
    await orm.migrator.up();
    await orm.em.getConnection().execute("ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ledger_no_update_delete");
    await orm.em.getConnection().execute("ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ledger_no_truncate");
    await orm.em.getConnection().execute("DELETE FROM wallet_ledger_entries");
    await orm.em.getConnection().execute("DELETE FROM wager_transactions");
    await orm.em.getConnection().execute("DELETE FROM outbox_messages");
    await orm.em.getConnection().execute("DELETE FROM inbox_messages");
    await orm.em.getConnection().execute("DELETE FROM wallets");
  });

  afterAll(async () => {
    await orm.close();
  });

  test("serializes same-wallet debits so no lost update occurs", async () => {
    const playerId = randomUUID();
    const walletService = new WalletApplicationService(orm.em.fork());
    const wallet = await walletService.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const first = new WageringApplicationService(orm.em.fork());
    const second = new WageringApplicationService(orm.em.fork());

    const [resA, resB] = await Promise.allSettled([
      first.submitWager(
        {
          providerId: "provider-a",
          externalTransactionId: randomUUID(),
          playerId,
          walletId: wallet.id,
          roundId: "round-1",
          gameId: "game-1",
          kind: "BET",
          money: { amount: "60.00", currency: "BRL" },
        },
        "provider-a:hot-wallet-1",
      ),
      second.submitWager(
        {
          providerId: "provider-b",
          externalTransactionId: randomUUID(),
          playerId,
          walletId: wallet.id,
          roundId: "round-2",
          gameId: "game-2",
          kind: "BET",
          money: { amount: "50.00", currency: "BRL" },
        },
        "provider-b:hot-wallet-2",
      ),
    ]);

    const statuses = [resA, resB].map((item) =>
      item.status === "fulfilled" ? item.value.status : "REJECTED",
    );

    expect(statuses).toContain("PROCESSED");
    expect(statuses).toContain("REJECTED");

    const finalWallet = await orm.em.fork().findOne(WalletEntity, { id: wallet.id });
    expect(finalWallet).toBeDefined();
    expect(Number(finalWallet!.balance)).toBeGreaterThanOrEqual(0);
    expect(Number(finalWallet!.balance)).toBeLessThan(100);
  });

  test("rejects the same idempotency key when the payload changes", async () => {
    const playerId = randomUUID();
    const walletService = new WalletApplicationService(orm.em.fork());
    const wallet = await walletService.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const service = new WageringApplicationService(orm.em.fork());
    const validPayload = {
      providerId: "provider-a",
      externalTransactionId: "same-key-conflict",
      playerId,
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET" as const,
      money: { amount: "20.00", currency: "BRL" },
    };

    const first = await service.submitWager(
      validPayload,
      "provider-a:same-key-conflict",
    );
    expect(first.status).toBe("PROCESSED");

    let conflictMessage = "";
    try {
      await service.submitWager(
        { ...validPayload, money: { amount: "30.00", currency: "BRL" } },
        "provider-a:same-key-conflict",
      );
    } catch (error) {
      conflictMessage = error instanceof Error ? error.message : String(error);
    }

    expect(conflictMessage).toBe(
      "Idempotency key already used with different payload",
    );
  });

  test("refunds a processed bet only once", async () => {
    const playerId = randomUUID();
    const walletService = new WalletApplicationService(orm.em.fork());
    const wallet = await walletService.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const service = new WageringApplicationService(orm.em.fork());

    const bet = await service.submitWager(
      {
        providerId: "provider-refund",
        externalTransactionId: "bet-refund",
        playerId,
        walletId: wallet.id,
        roundId: "round-refund",
        gameId: "game",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      },
      "provider-refund:bet-refund",
    );

    const refund = await service.submitWager(
      {
        providerId: "provider-refund",
        externalTransactionId: "refund-1",
        playerId,
        walletId: wallet.id,
        roundId: "round-refund",
        gameId: "game",
        kind: "REFUND",
        referenceExternalTransactionId: "bet-refund",
        money: { amount: "25.00", currency: "BRL" },
      },
      "provider-refund:refund-1",
    );

    const duplicate = await service.submitWager(
      {
        providerId: "provider-refund",
        externalTransactionId: "refund-2",
        playerId,
        walletId: wallet.id,
        roundId: "round-refund",
        gameId: "game",
        kind: "REFUND",
        referenceExternalTransactionId: "bet-refund",
        money: { amount: "25.00", currency: "BRL" },
      },
      "provider-refund:refund-2",
    );

    expect(bet.status).toBe("PROCESSED");
    expect(refund.status).toBe("PROCESSED");
    expect(refund.balance.amount).toBe("100.00");
    expect(duplicate.status).toBe("REJECTED");

    const entries = await orm.em.fork().find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
    });
    expect(entries.length).toBe(3);
  });

  test("rolls back a processed win with the inverse ledger direction", async () => {
    const playerId = randomUUID();
    const walletService = new WalletApplicationService(orm.em.fork());
    const wallet = await walletService.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const service = new WageringApplicationService(orm.em.fork());

    await service.submitWager(
      {
        providerId: "provider-rollback",
        externalTransactionId: "win-rollback",
        playerId,
        walletId: wallet.id,
        roundId: "round-rollback",
        gameId: "game",
        kind: "WIN",
        money: { amount: "50.00", currency: "BRL" },
      },
      "provider-rollback:win-rollback",
    );

    const rollback = await service.submitWager(
      {
        providerId: "provider-rollback",
        externalTransactionId: "rollback-1",
        playerId,
        walletId: wallet.id,
        roundId: "round-rollback",
        gameId: "game",
        kind: "ROLLBACK",
        referenceExternalTransactionId: "win-rollback",
        money: { amount: "50.00", currency: "BRL" },
      },
      "provider-rollback:rollback-1",
    );

    expect(rollback.status).toBe("PROCESSED");
    expect(rollback.balance.amount).toBe("100.00");

    const entries = await orm.em.fork().find(
      WalletLedgerEntryEntity,
      { walletId: wallet.id },
      { orderBy: { seq: "ASC" } },
    );
    expect(entries.map((entry) => entry.direction).join(",")).toBe(
      "CREDIT,CREDIT,DEBIT",
    );
  });

  test("reprocesses a pending refund after its reference arrives", async () => {
    const playerId = randomUUID();
    const walletService = new WalletApplicationService(orm.em.fork());
    const wallet = await walletService.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const service = new WageringApplicationService(orm.em.fork());

    const pending = await service.submitWager(
      {
        providerId: "provider-pending",
        externalTransactionId: "refund-before-bet",
        playerId,
        walletId: wallet.id,
        roundId: "round-pending",
        gameId: "game",
        kind: "REFUND",
        referenceExternalTransactionId: "late-bet",
        money: { amount: "10.00", currency: "BRL" },
      },
      "provider-pending:refund-before-bet",
    );

    await service.submitWager(
      {
        providerId: "provider-pending",
        externalTransactionId: "late-bet",
        playerId,
        walletId: wallet.id,
        roundId: "round-pending",
        gameId: "game",
        kind: "BET",
        money: { amount: "10.00", currency: "BRL" },
      },
      "provider-pending:late-bet",
    );

    await orm.em.nativeUpdate(
      WagerTransactionEntity,
      { id: pending.transactionId },
      { nextAttemptAt: new Date(0) },
    );

    expect(pending.status).toBe("PENDING_REFERENCE");
    expect(await service.processPendingReferences()).toBe(1);

    const processed = await service.findTransactionByProviderReference(
      "provider-pending",
      "refund-before-bet",
    );
    expect(processed.status).toBe("PROCESSED");
    expect(processed.observedBalance?.amount).toBe("100.00");
  });
});
