import "reflect-metadata";
import { MikroORM } from "@mikro-orm/core";
import { NestFactory } from "@nestjs/core";
import { randomUUID } from "node:crypto";
import { AppModule } from "../../src/app.module";
import { WalletEntity } from "../../src/infrastructure/persistence/entities/wallet.entity";
import { WalletLedgerEntryEntity } from "../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { WagerTransactionEntity } from "../../src/infrastructure/persistence/entities/wager-transaction.entity";
import { OutboxMessageEntity } from "../../src/infrastructure/persistence/entities/outbox-message.entity";
import { InboxMessageEntity } from "../../src/infrastructure/persistence/entities/inbox-message.entity";

type HttpResponse = {
  status: number;
  body: any;
};

const request = async (
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<HttpResponse> => {
  const parsedBody =
    typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
  const apiKey = path.startsWith("/queues")
    ? process.env.INTERNAL_API_KEY
    : path.startsWith("/wagering") || path.startsWith("/providers")
      ? process.env.PROVIDER_API_KEY
      : init?.method === "POST" &&
          (path === "/wallets" || path.endsWith("/reconciliation"))
        ? process.env.ADMIN_API_KEY
        : process.env.API_KEY;
  const providerHeaders =
    typeof parsedBody.providerId === "string"
      ? { "x-provider-id": parsedBody.providerId }
      : {};
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey!,
      ...providerHeaders,
      ...init?.headers,
    } as Record<string, string>,
  });
  const responseBody = await response.json();
  return { status: response.status, body: responseBody };
};

const post = (
  body: unknown,
  headers?: Record<string, string>,
): RequestInit => ({
  method: "POST",
  headers,
  body: JSON.stringify(body),
});

const walletPayload = (playerId = randomUUID(), amount = "100.00") => ({
  playerId,
  initialBalance: { amount, currency: "BRL" },
});

const wagerPayload = (walletId: string, playerId: string, overrides = {}) => ({
  providerId: "provider-http",
  externalTransactionId: randomUUID(),
  playerId,
  walletId,
  roundId: "round-http",
  gameId: "game-http",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
  ...overrides,
});

describe("rotas HTTP financeiras", () => {
  let app: any;
  let orm: MikroORM;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.API_KEY = "test-read-key";
    process.env.ADMIN_API_KEY = "test-admin-key";
    process.env.PROVIDER_API_KEY = "test-provider-key";
    process.env.ALLOWED_PROVIDER_IDS = "provider-http";
    process.env.INTERNAL_API_KEY = "test-internal-key";
    process.env.NODE_ENV = "test";
    app = await NestFactory.create(AppModule);
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();
    orm = app.get(MikroORM);
    await orm.migrator.up();
    const connection = orm.em.getConnection();
    await connection.execute(
      "ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ledger_no_update_delete",
    );
    await connection.execute(
      "ALTER TABLE wallet_ledger_entries DISABLE TRIGGER ledger_no_truncate",
    );
    await connection.execute("DELETE FROM wallet_ledger_entries");
    await connection.execute("DELETE FROM wager_transactions");
    await connection.execute("DELETE FROM outbox_messages");
    await connection.execute("DELETE FROM inbox_messages");
    await connection.execute("DELETE FROM wallets");
  });

  afterAll(async () => {
    await app.close();
  });

  test("quando a carteira é acessada sem uma chave válida, então rejeita", async () => {
    const response = await request(
      baseUrl,
      `/wallets/${randomUUID()}`,
      { method: "GET", headers: { "x-api-key": "invalid" } },
    );
    expect(response.status).toBe(401);
  });

  test("quando a identidade do provedor diverge do payload, então rejeita", async () => {
    const response = await request(
      baseUrl,
      "/wagering/transactions",
      post(
        wagerPayload(randomUUID(), randomUUID()),
        {
          "idempotency-key": `http:${randomUUID()}`,
          "x-provider-id": "different-provider",
        },
      ),
    );
    expect(response.status).toBe(400);
  });

  test("quando os dados são válidos, então cria a carteira e registra o saldo inicial", async () => {
    const response = await request(baseUrl, "/wallets", post(walletPayload()));
    expect(response.status).toBe(201);
    expect(response.body.balance.amount).toBe("100.00");

    const entries = await orm.em.fork().find(WalletLedgerEntryEntity, {
      walletId: response.body.id,
    });
    expect(entries.length).toBe(1);
  });

  test("quando a carteira já existe, então rejeita a duplicação", async () => {
    const payload = walletPayload();
    const first = await request(baseUrl, "/wallets", post(payload));
    const second = await request(baseUrl, "/wallets", post(payload));
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });

  test("quando duas criações iguais ocorrem simultaneamente, então apenas uma carteira é criada", async () => {
    const payload = walletPayload();
    const responses = await Promise.all([
      request(baseUrl, "/wallets", post(payload)),
      request(baseUrl, "/wallets", post(payload)),
    ]);
    expect(responses.filter((response) => response.status === 201).length).toBe(
      1,
    );
    expect(responses.filter((response) => response.status === 409).length).toBe(
      1,
    );
  });

  test("quando BET possui saldo suficiente, então debita a carteira e registra o ledger", async () => {
    const playerId = randomUUID();
    const wallet = await request(
      baseUrl,
      "/wallets",
      post(walletPayload(playerId)),
    );
    const response = await request(
      baseUrl,
      "/wagering/transactions",
      post(wagerPayload(wallet.body.id, playerId), {
        "idempotency-key": `http:${randomUUID()}`,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("PROCESSED");
    expect(response.body.balance.amount).toBe("75.00");
  });

  test("quando o saldo é insuficiente, então rejeita sem deixar saldo negativo", async () => {
    const playerId = randomUUID();
    const wallet = await request(
      baseUrl,
      "/wallets",
      post(walletPayload(playerId, "10.00")),
    );
    const response = await request(
      baseUrl,
      "/wagering/transactions",
      post(
        wagerPayload(wallet.body.id, playerId, {
          money: { amount: "25.00", currency: "BRL" },
        }),
        { "idempotency-key": `http:${randomUUID()}` },
      ),
    );
    expect(response.status).toBe(422);
    const persisted = await request(baseUrl, `/wallets/${wallet.body.id}`);
    expect(persisted.body.balance.amount).toBe("10.00");
  });

  test("quando a mesma requisição é repetida, então retorna replay sem novo débito", async () => {
    const playerId = randomUUID();
    const wallet = await request(
      baseUrl,
      "/wallets",
      post(walletPayload(playerId)),
    );
    const key = `http:${randomUUID()}`;
    const payload = wagerPayload(wallet.body.id, playerId, {
      externalTransactionId: "duplicate-http",
    });
    const responses = await Promise.all([
      request(
        baseUrl,
        "/wagering/transactions",
        post(payload, { "idempotency-key": key }),
      ),
      request(
        baseUrl,
        "/wagering/transactions",
        post(payload, { "idempotency-key": key }),
      ),
    ]);
    expect(responses.filter((response) => response.status === 200).length).toBe(
      2,
    );
    expect(
      (await request(baseUrl, `/wallets/${wallet.body.id}`)).body.balance
        .amount,
    ).toBe("75.00");
  });

  test("quando a chave é reutilizada com payload diferente, então rejeita o conflito", async () => {
    const playerId = randomUUID();
    const wallet = await request(
      baseUrl,
      "/wallets",
      post(walletPayload(playerId)),
    );
    const key = `http:${randomUUID()}`;
    const first = await request(
      baseUrl,
      "/wagering/transactions",
      post(wagerPayload(wallet.body.id, playerId), { "idempotency-key": key }),
    );
    const second = await request(
      baseUrl,
      "/wagering/transactions",
      post(
        wagerPayload(wallet.body.id, playerId, {
          money: { amount: "30.00", currency: "BRL" },
        }),
        { "idempotency-key": key },
      ),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  test("quando duas apostas chegam simultaneamente, então uma é rejeitada e o saldo não fica negativo", async () => {
    const playerId = randomUUID();
    const wallet = await request(
      baseUrl,
      "/wallets",
      post(walletPayload(playerId, "100.00")),
    );
    const responses = await Promise.all([
      request(
        baseUrl,
        "/wagering/transactions",
        post(
          wagerPayload(wallet.body.id, playerId, {
            money: { amount: "60.00", currency: "BRL" },
          }),
          { "idempotency-key": `http:${randomUUID()}` },
        ),
      ),
      request(
        baseUrl,
        "/wagering/transactions",
        post(
          wagerPayload(wallet.body.id, playerId, {
            money: { amount: "50.00", currency: "BRL" },
          }),
          { "idempotency-key": `http:${randomUUID()}` },
        ),
      ),
    ]);
    expect(responses.filter((response) => response.status === 200).length).toBe(
      1,
    );
    expect(responses.filter((response) => response.status === 422).length).toBe(
      1,
    );
    expect(
      Number(
        (await request(baseUrl, `/wallets/${wallet.body.id}`)).body.balance
          .amount,
      ),
    ).toBeGreaterThanOrEqual(0);
  });

  test("quando a referência de REFUND não existe, então a transação fica pendente", async () => {
    const playerId = randomUUID();
    const wallet = await request(
      baseUrl,
      "/wallets",
      post(walletPayload(playerId)),
    );
    const response = await request(
      baseUrl,
      "/wagering/transactions",
      post(
        wagerPayload(wallet.body.id, playerId, {
          kind: "REFUND",
          referenceExternalTransactionId: "missing-reference",
        }),
        { "idempotency-key": `http:${randomUUID()}` },
      ),
    );
    expect(response.status).toBe(202);
    expect(response.body.status).toBe("PENDING_REFERENCE");
  });

  test("quando o ledger é consultado com cursor inválido, então rejeita a requisição", async () => {
    const playerId = randomUUID();
    const wallet = await request(
      baseUrl,
      "/wallets",
      post(walletPayload(playerId)),
    );
    const response = await request(
      baseUrl,
      `/wallets/${wallet.body.id}/ledger?cursor=invalid`,
    );
    expect(response.status).toBe(400);
  });

  test("quando a carteira não existe, então as consultas retornam não encontrado", async () => {
    const response = await request(baseUrl, `/wallets/${randomUUID()}`);
    expect(response.status).toBe(404);
  });

  test("quando o ledger e o saldo são consistentes, então a reconciliação confirma a consistência", async () => {
    const playerId = randomUUID();
    const wallet = await request(
      baseUrl,
      "/wallets",
      post(walletPayload(playerId)),
    );
    const response = await request(
      baseUrl,
      `/wallets/${wallet.body.id}/reconciliation`,
      post({}),
    );
    expect(response.status).toBe(201);
    expect(response.body.consistent).toBeTruthy();
  });

  test("quando há evento pendente, então a rota de outbox o publica", async () => {
    const playerId = randomUUID();
    await request(baseUrl, "/wallets", post(walletPayload(playerId)));
    const response = await request(
      baseUrl,
      "/queues/outbox/publish",
      post({ limit: 10 }),
    );
    expect(response.status).toBe(201);
    expect(response.body.length).toBeGreaterThan(0);
  });

  test("quando a mesma mensagem é entregue novamente, então a rota de inbox não a processa duas vezes", async () => {
    const payload = {
      consumerName: "http-test",
      messageId: randomUUID(),
      payload: { operation: "debit" },
    };
    const first = await request(
      baseUrl,
      "/queues/inbox/consume",
      post(payload),
    );
    const second = await request(
      baseUrl,
      "/queues/inbox/consume",
      post(payload),
    );
    expect(first.status).toBe(201);
    expect(first.body).toBeFalsy();
    expect(second.status).toBe(201);
    expect(second.body).toBeTruthy();
  });

  test("quando a mesma chave chega para carteiras diferentes, então apenas uma é processada", async () => {
    const walletA = await request(baseUrl, "/wallets", post(walletPayload()));
    const walletB = await request(baseUrl, "/wallets", post(walletPayload()));
    const key = `http:${randomUUID()}`;

    const responses = await Promise.all([
      request(
        baseUrl,
        "/wagering/transactions",
        post(
          wagerPayload(walletA.body.id, walletA.body.playerId, {
            externalTransactionId: randomUUID(),
          }),
          { "idempotency-key": key },
        ),
      ),
      request(
        baseUrl,
        "/wagering/transactions",
        post(
          wagerPayload(walletB.body.id, walletB.body.playerId, {
            externalTransactionId: randomUUID(),
          }),
          { "idempotency-key": key },
        ),
      ),
    ]);

    expect(responses.filter((response) => response.status === 200).length).toBe(
      1,
    );
    expect(responses.filter((response) => response.status === 409).length).toBe(
      1,
    );

    const balances = await Promise.all(
      [walletA, walletB].map((wallet) =>
        request(baseUrl, `/wallets/${wallet.body.id}`),
      ),
    );
    expect(
      balances
        .map((response) => response.body.balance.amount)
        .sort()
        .join(","),
    ).toBe("100.00,75.00");
  });

  test("quando a rota de transação não recebe chave de idempotência, então rejeita a requisição", async () => {
    const response = await request(
      baseUrl,
      "/wagering/transactions",
      post(wagerPayload(randomUUID(), randomUUID())),
    );
    expect(response.status).toBe(400);
  });

  test("quando a rota de métricas é consultada, então retorna métricas do processo", async () => {
    const response = await request(baseUrl, "/metrics");
    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();
  });
});
