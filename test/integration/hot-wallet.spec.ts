import { MikroORM, type EntityManager } from "@mikro-orm/core";
import { ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { WageringApplicationService } from "../../src/application/wagering/wagering-application.service";
import { WalletApplicationService } from "../../src/application/wallet/wallet-application.service";
import { WalletEntity } from "../../src/infrastructure/persistence/entities/wallet.entity";
import { WalletLedgerEntryEntity } from "../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { WagerTransactionEntity } from "../../src/infrastructure/persistence/entities/wager-transaction.entity";
import { OutboxMessageEntity } from "../../src/infrastructure/persistence/entities/outbox-message.entity";
import { OutboxProcessorService } from "../../src/infrastructure/messaging/outbox-processor.service";
import { MetricsService } from "../../src/infrastructure/observability/metrics.service";
import {
  InboxMessageService,
  type InboxEnvelope,
} from "../../src/infrastructure/messaging/inbox-message.service";
import { InboxMessageEntity } from "../../src/infrastructure/persistence/entities/inbox-message.entity";
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

  test("keeps the balance correct across three application instances", async () => {
    const playerId = randomUUID();
    const walletService = new WalletApplicationService(orm.em.fork());
    const wallet = await walletService.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const services = [1, 2, 3].map(
      () => new WageringApplicationService(orm.em.fork()),
    );

    const results = await Promise.all(
      services.map((service, index) =>
        service.submitWager(
          {
            providerId: `provider-instance-${index}`,
            externalTransactionId: `instance-${index}`,
            playerId,
            walletId: wallet.id,
            roundId: "round-instances",
            gameId: "game",
            kind: "BET",
            money: { amount: "40.00", currency: "BRL" },
          },
          `provider-instance-${index}:instance-${index}`,
        ),
      ),
    );

    const finalWallet = await orm.em.fork().findOne(WalletEntity, {
      id: wallet.id,
    });
    const entries = await orm.em.fork().find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
    });

    expect(results.filter((result) => result.status === "PROCESSED").length).toBe(
      2,
    );
    expect(results.filter((result) => result.status === "REJECTED").length).toBe(
      1,
    );
    expect(finalWallet?.balance).toBe("20.00");
    expect(entries.length).toBe(3);
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

  test("processes 50 duplicate requests with a single debit", async () => {
    const playerId = randomUUID();
    const walletService = new WalletApplicationService(orm.em.fork());
    const wallet = await walletService.createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const requests = Array.from({ length: 50 }, () =>
      new WageringApplicationService(orm.em.fork()).submitWager(
        {
          providerId: "provider-duplicates",
          externalTransactionId: "duplicate-50",
          playerId,
          walletId: wallet.id,
          roundId: "round-duplicates",
          gameId: "game",
          kind: "BET",
          money: { amount: "25.00", currency: "BRL" },
        },
        "provider-duplicates:duplicate-50",
      ),
    );

    const results = await Promise.all(requests);
    const processed = results.filter(
      (result) => result.status === "PROCESSED" && !result.idempotentReplay,
    );
    const replays = results.filter((result) => result.idempotentReplay);
    const finalWallet = await orm.em.fork().findOne(WalletEntity, {
      id: wallet.id,
    });
    const entries = await orm.em.fork().find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
    });

    expect(processed.length).toBe(1);
    expect(replays.length).toBe(49);
    expect(finalWallet?.balance).toBe("75.00");
    expect(entries.length).toBe(2);
  });

  test("does not publish the same outbox message twice with concurrent publishers", async () => {
    await orm.em.getConnection().execute("DELETE FROM outbox_messages");
    const message = orm.em.fork().create(OutboxMessageEntity, {
      id: randomUUID(),
      aggregateId: randomUUID(),
      eventType: "TestEvent",
      payload: { eventId: randomUUID() },
      occurredAt: new Date(),
      attempts: 0,
      nextAttemptAt: new Date(),
      publishedAt: null,
    });
    const seedEm = orm.em.fork();
    seedEm.persist(message);
    await seedEm.flush();

    let publishCount = 0;
    const transport = {
      publish: async () => {
        publishCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      publishDeadLetter: async () => undefined,
    };
    const first = new OutboxProcessorService(
      orm.em.fork(),
      transport as never,
      new MetricsService(),
    );
    const second = new OutboxProcessorService(
      orm.em.fork(),
      transport as never,
      new MetricsService(),
    );

    await Promise.all([
      first.publishNextPending(),
      second.publishNextPending(),
    ]);

    expect(publishCount).toBe(1);
    const persisted = await orm.em.fork().findOne(OutboxMessageEntity, {
      id: message.id,
    });
    expect(persisted?.publishedAt).toBeDefined();
  });

  test("redelivers an inbox message after a failure before commit", async () => {
    const inbox = new InboxMessageService(
      orm.em.fork(),
      new MetricsService(),
    );
    const envelope: InboxEnvelope<{ operation: string }> = {
      consumerName: "recovery-test",
      messageId: randomUUID(),
      payload: { operation: "debit" },
    };

    let failed = false;
    try {
      await inbox.consume(envelope, async () => {
        failed = true;
        throw new Error("simulated crash before ack");
      });
    } catch (error) {
      expect(error instanceof Error).toBeTruthy();
    }

    expect(failed).toBeTruthy();
    expect(
      await orm.em.fork().findOne(InboxMessageEntity, {
        consumerName: envelope.consumerName,
        messageId: envelope.messageId,
      }),
    ).toBeFalsy();

    const redelivery = await inbox.consume(envelope, async () => undefined);
    expect(redelivery).toBeFalsy();

    const persisted = await orm.em.fork().findOne(InboxMessageEntity, {
      consumerName: envelope.consumerName,
      messageId: envelope.messageId,
    });
    expect(persisted?.processedAt).toBeDefined();
  });

  test("a new outbox publisher resumes a failed publication", async () => {
    await orm.em.getConnection().execute("DELETE FROM outbox_messages");
    const message = orm.em.fork().create(OutboxMessageEntity, {
      id: randomUUID(),
      aggregateId: randomUUID(),
      eventType: "RecoveryEvent",
      payload: { eventId: randomUUID() },
      occurredAt: new Date(),
      attempts: 0,
      nextAttemptAt: new Date(),
      publishedAt: null,
    });
    const seedEm = orm.em.fork();
    seedEm.persist(message);
    await seedEm.flush();

    const failingTransport = {
      publish: async () => {
        throw new Error("simulated publisher crash");
      },
      publishDeadLetter: async () => undefined,
    };
    const first = new OutboxProcessorService(
      orm.em.fork(),
      failingTransport as never,
      new MetricsService(),
    );
    const firstResult = await first.publishNextPending();
    expect(firstResult[0]?.published).toBeFalsy();

    await orm.em.nativeUpdate(
      OutboxMessageEntity,
      { id: message.id },
      { nextAttemptAt: new Date(0) },
    );

    let published = 0;
    const recoveringTransport = {
      publish: async () => {
        published += 1;
      },
      publishDeadLetter: async () => undefined,
    };
    const second = new OutboxProcessorService(
      orm.em.fork(),
      recoveringTransport as never,
      new MetricsService(),
    );
    const secondResult = await second.publishNextPending();

    expect(published).toBe(1);
    expect(secondResult[0]?.published).toBeTruthy();
    expect(
      (await orm.em.fork().findOne(OutboxMessageEntity, { id: message.id }))
        ?.publishedAt,
    ).toBeDefined();
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

  test("same idempotency key racing across wallets only affects one wallet", async () => {
    const key = `provider-key-race:${randomUUID()}`;
    const playerA = randomUUID();
    const playerB = randomUUID();
    const walletA = await new WalletApplicationService(
      orm.em.fork(),
    ).createWallet({
      playerId: playerA,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const walletB = await new WalletApplicationService(
      orm.em.fork(),
    ).createWallet({
      playerId: playerB,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const results = await Promise.allSettled([
      new WageringApplicationService(orm.em.fork()).submitWager(
        {
          providerId: "provider-key-race",
          externalTransactionId: randomUUID(),
          playerId: playerA,
          walletId: walletA.id,
          roundId: "round-key-race-a",
          gameId: "game",
          kind: "BET",
          money: { amount: "25.00", currency: "BRL" },
        },
        key,
      ),
      new WageringApplicationService(orm.em.fork()).submitWager(
        {
          providerId: "provider-key-race",
          externalTransactionId: randomUUID(),
          playerId: playerB,
          walletId: walletB.id,
          roundId: "round-key-race-b",
          gameId: "game",
          kind: "BET",
          money: { amount: "25.00", currency: "BRL" },
        },
        key,
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled").length).toBe(
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected" &&
        rejected.reason instanceof ConflictException,
    ).toBe(true);

    const wallets = await orm.em.fork().find(WalletEntity, {
      id: { $in: [walletA.id, walletB.id] },
    });
    expect(wallets.map((wallet) => wallet.balance).sort().join(",")).toBe(
      "100.00,75.00",
    );
    const debits = await orm.em.fork().find(WalletLedgerEntryEntity, {
      walletId: { $in: [walletA.id, walletB.id] },
      direction: "DEBIT",
    });
    expect(debits.length).toBe(1);
  });

  test("same external transaction id racing under different keys only affects one wallet", async () => {
    const providerId = "provider-external-race";
    const externalTransactionId = randomUUID();
    const playerA = randomUUID();
    const playerB = randomUUID();
    const walletA = await new WalletApplicationService(
      orm.em.fork(),
    ).createWallet({
      playerId: playerA,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const walletB = await new WalletApplicationService(
      orm.em.fork(),
    ).createWallet({
      playerId: playerB,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const results = await Promise.allSettled([
      new WageringApplicationService(orm.em.fork()).submitWager(
        {
          providerId,
          externalTransactionId,
          playerId: playerA,
          walletId: walletA.id,
          roundId: "round-external-race-a",
          gameId: "game",
          kind: "BET",
          money: { amount: "25.00", currency: "BRL" },
        },
        `${providerId}:key-a:${randomUUID()}`,
      ),
      new WageringApplicationService(orm.em.fork()).submitWager(
        {
          providerId,
          externalTransactionId,
          playerId: playerB,
          walletId: walletB.id,
          roundId: "round-external-race-b",
          gameId: "game",
          kind: "BET",
          money: { amount: "25.00", currency: "BRL" },
        },
        `${providerId}:key-b:${randomUUID()}`,
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled").length).toBe(
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected" &&
        rejected.reason instanceof ConflictException,
    ).toBe(true);

    const wallets = await orm.em.fork().find(WalletEntity, {
      id: { $in: [walletA.id, walletB.id] },
    });
    expect(wallets.map((wallet) => wallet.balance).sort().join(",")).toBe(
      "100.00,75.00",
    );
  });

  test("REFUND and ROLLBACK racing for the same reference reverse it only once", async () => {
    const providerId = "provider-reversal-race";
    const playerId = randomUUID();
    const wallet = await new WalletApplicationService(
      orm.em.fork(),
    ).createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const bet = await new WageringApplicationService(
      orm.em.fork(),
    ).submitWager(
      {
        providerId,
        externalTransactionId: "bet-reversal-race",
        playerId,
        walletId: wallet.id,
        roundId: "round-reversal-race",
        gameId: "game",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      },
      `${providerId}:bet-reversal-race`,
    );
    expect(bet.status).toBe("PROCESSED");

    const [refund, rollback] = await Promise.all([
      new WageringApplicationService(orm.em.fork()).submitWager(
        {
          providerId,
          externalTransactionId: "refund-reversal-race",
          playerId,
          walletId: wallet.id,
          roundId: "round-reversal-race",
          gameId: "game",
          kind: "REFUND",
          referenceExternalTransactionId: "bet-reversal-race",
          money: { amount: "25.00", currency: "BRL" },
        },
        `${providerId}:refund-reversal-race`,
      ),
      new WageringApplicationService(orm.em.fork()).submitWager(
        {
          providerId,
          externalTransactionId: "rollback-reversal-race",
          playerId,
          walletId: wallet.id,
          roundId: "round-reversal-race",
          gameId: "game",
          kind: "ROLLBACK",
          referenceExternalTransactionId: "bet-reversal-race",
          money: { amount: "25.00", currency: "BRL" },
        },
        `${providerId}:rollback-reversal-race`,
      ),
    ]);

    const outcomes = [refund, rollback];
    expect(
      outcomes.filter((outcome) => outcome.status === "PROCESSED").length,
    ).toBe(1);
    const rejected = outcomes.filter((outcome) => outcome.status === "REJECTED");
    expect(rejected.length).toBe(1);
    const rejectedTransaction = await new WageringApplicationService(
      orm.em.fork(),
    ).findTransactionById(rejected[0]!.transactionId);
    expect(rejectedTransaction.failureCode).toBe("ALREADY_REVERSED");

    const finalWallet = await orm.em.fork().findOne(WalletEntity, {
      id: wallet.id,
    });
    expect(finalWallet?.balance).toBe("100.00");
    const entries = await orm.em.fork().find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
    });
    expect(entries.length).toBe(3);
  });

  test("concurrent duplicate inbox delivery runs the handler exactly once", async () => {
    const envelope: InboxEnvelope<{ operation: string }> = {
      consumerName: "concurrent-inbox",
      messageId: randomUUID(),
      payload: { operation: "debit" },
    };
    let handled = 0;
    const handler = async () => {
      handled += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const results = await Promise.all([
      new InboxMessageService(orm.em.fork(), new MetricsService()).consume(
        envelope,
        handler,
      ),
      new InboxMessageService(orm.em.fork(), new MetricsService()).consume(
        envelope,
        handler,
      ),
    ]);

    expect(handled).toBe(1);
    expect(results.filter((result) => result === false).length).toBe(1);
    expect(results.filter((result) => result === true).length).toBe(1);

    const persisted = await orm.em.fork().findOne(InboxMessageEntity, {
      consumerName: envelope.consumerName,
      messageId: envelope.messageId,
    });
    expect(persisted?.processedAt).toBeDefined();
  });

  test("duplicate pending-reference requests do not increment attempts before they are due", async () => {
    const providerId = "provider-pending-attempts";
    const playerId = randomUUID();
    const wallet = await new WalletApplicationService(
      orm.em.fork(),
    ).createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const input = {
      providerId,
      externalTransactionId: "refund-pending-attempts",
      playerId,
      walletId: wallet.id,
      roundId: "round-pending-attempts",
      gameId: "game",
      kind: "REFUND" as const,
      referenceExternalTransactionId: "missing-pending-reference",
      money: { amount: "10.00", currency: "BRL" },
    };
    const key = `${providerId}:refund-pending-attempts`;

    const pending = await new WageringApplicationService(
      orm.em.fork(),
    ).submitWager(input, key);
    expect(pending.status).toBe("PENDING_REFERENCE");
    expect(pending.balance.amount).toBe("100.00");

    const duplicates = await Promise.all([
      new WageringApplicationService(orm.em.fork()).submitWager(input, key),
      new WageringApplicationService(orm.em.fork()).submitWager(input, key),
    ]);
    expect(duplicates.map((result) => result.status).join(",")).toBe(
      "PENDING_REFERENCE,PENDING_REFERENCE",
    );
    expect(duplicates.every((result) => result.idempotentReplay)).toBe(true);
    expect(duplicates.map((result) => result.balance.amount).join(",")).toBe(
      "100.00,100.00",
    );

    const stored = await orm.em.fork().findOne(WagerTransactionEntity, {
      id: pending.transactionId,
    });
    expect(stored?.attempts).toBe(1);
  });

  test("applies a wager event delivered twice sequentially only once", async () => {
    const playerId = randomUUID();
    const wallet = await new WalletApplicationService(
      orm.em.fork(),
    ).createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const providerId = "provider-inbox-sequential";
    const externalTransactionId = randomUUID();
    const input = {
      providerId,
      externalTransactionId,
      playerId,
      walletId: wallet.id,
      roundId: "round-inbox-sequential",
      gameId: "game",
      kind: "BET" as const,
      money: { amount: "25.00", currency: "BRL" },
    };
    const key = `${providerId}:${externalTransactionId}`;
    const envelope: InboxEnvelope<typeof input> = {
      consumerName: "wager-inbox-sequential",
      messageId: randomUUID(),
      payload: input,
    };
    let handled = 0;
    const handler = async (tx: EntityManager, payload: typeof input) => {
      handled += 1;
      await new WageringApplicationService(orm.em.fork()).submitWager(
        payload,
        key,
        tx,
      );
    };
    const inbox = new InboxMessageService(
      orm.em.fork(),
      new MetricsService(),
    );

    expect(await inbox.consume(envelope, handler)).toBe(false);
    expect(await inbox.consume(envelope, handler)).toBe(true);

    expect(handled).toBe(1);
    const finalWallet = await orm.em.fork().findOne(WalletEntity, {
      id: wallet.id,
    });
    const entries = await orm.em.fork().find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: "DEBIT",
    });
    expect(finalWallet?.balance).toBe("75.00");
    expect(entries.length).toBe(1);
  });

  test("applies a wager event delivered twice simultaneously only once", async () => {
    const playerId = randomUUID();
    const wallet = await new WalletApplicationService(
      orm.em.fork(),
    ).createWallet({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    const providerId = "provider-inbox-concurrent";
    const externalTransactionId = randomUUID();
    const input = {
      providerId,
      externalTransactionId,
      playerId,
      walletId: wallet.id,
      roundId: "round-inbox-concurrent",
      gameId: "game",
      kind: "BET" as const,
      money: { amount: "25.00", currency: "BRL" },
    };
    const key = `${providerId}:${externalTransactionId}`;
    const envelope: InboxEnvelope<typeof input> = {
      consumerName: "wager-inbox-concurrent",
      messageId: randomUUID(),
      payload: input,
    };
    let handled = 0;
    const handler = async (tx: EntityManager, payload: typeof input) => {
      handled += 1;
      await new WageringApplicationService(orm.em.fork()).submitWager(
        payload,
        key,
        tx,
      );
    };

    const results = await Promise.all([
      new InboxMessageService(
        orm.em.fork(),
        new MetricsService(),
      ).consume(envelope, handler),
      new InboxMessageService(
        orm.em.fork(),
        new MetricsService(),
      ).consume(envelope, handler),
    ]);

    expect(handled).toBe(1);
    expect(results.filter((result) => result === false).length).toBe(1);
    expect(results.filter((result) => result === true).length).toBe(1);

    const finalWallet = await orm.em.fork().findOne(WalletEntity, {
      id: wallet.id,
    });
    const entries = await orm.em.fork().find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: "DEBIT",
    });
    expect(finalWallet?.balance).toBe("75.00");
    expect(entries.length).toBe(1);
  });

  test("rejects the same inbox message id when a nested payload changes", async () => {
    const consumerName = "inbox-nested-conflict";
    const messageId = randomUUID();
    const inbox = new InboxMessageService(
      orm.em.fork(),
      new MetricsService(),
    );

    expect(
      await inbox.consume({
        consumerName,
        messageId,
        payload: { data: { amount: "10.00", currency: "BRL" } },
      }),
    ).toBe(false);

    let conflict: unknown;
    try {
      await inbox.consume({
        consumerName,
        messageId,
        payload: { data: { amount: "20.00", currency: "BRL" } },
      });
    } catch (error) {
      conflict = error;
    }

    expect(conflict instanceof ConflictException).toBe(true);
  });

  test("treats reordered nested keys as the same inbox payload", async () => {
    const consumerName = "inbox-nested-replay";
    const messageId = randomUUID();
    const inbox = new InboxMessageService(
      orm.em.fork(),
      new MetricsService(),
    );

    expect(
      await inbox.consume({
        consumerName,
        messageId,
        payload: {
          data: { amount: "10.00", currency: "BRL" },
          meta: { beta: 2, alpha: 1 },
        },
      }),
    ).toBe(false);

    expect(
      await inbox.consume({
        consumerName,
        messageId,
        payload: {
          meta: { alpha: 1, beta: 2 },
          data: { currency: "BRL", amount: "10.00" },
        },
      }),
    ).toBe(true);
  });
});
