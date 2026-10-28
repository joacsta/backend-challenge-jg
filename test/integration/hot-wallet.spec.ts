import { MikroORM } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { WageringApplicationService } from "../../src/application/wagering/wagering-application.service";
import { WalletApplicationService } from "../../src/application/wallet/wallet-application.service";
import { WalletEntity } from "../../src/infrastructure/persistence/entities/wallet.entity";
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
});
