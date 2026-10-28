import { describe, expect, test } from "bun:test";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction";

describe("WagerTransaction", () => {
  test("creates a BET transaction in pending state", () => {
    const tx = WagerTransaction.create({
      id: "tx-1",
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      idempotencyKey: "provider-a:ext-1",
      payloadHash: "hash-1",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "25.00", currency: "BRL" },
    });

    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
  });

  test("requires a reference for refund and rollback", () => {
    expect(() =>
      WagerTransaction.create({
        id: "tx-2",
        providerId: "provider-a",
        externalTransactionId: "ext-2",
        idempotencyKey: "provider-a:ext-2",
        payloadHash: "hash-2",
        walletId: "wallet-1",
        playerId: "player-1",
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        money: { amount: "25.00", currency: "BRL" },
      }),
    ).toThrow();
  });

  test("marks processed and terminal state cannot be mutated", () => {
    const tx = WagerTransaction.create({
      id: "tx-3",
      providerId: "provider-a",
      externalTransactionId: "ext-3",
      idempotencyKey: "provider-a:ext-3",
      payloadHash: "hash-3",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Win,
      money: { amount: "40.00", currency: "BRL" },
    });

    tx.markProcessed(undefined, new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(() => tx.reject("RULE_REJECTION")).toThrow();
  });

  test("rollbacks direction is based on reference kind", () => {
    const bet = WagerTransaction.create({
      id: "tx-4",
      providerId: "provider-a",
      externalTransactionId: "ext-4",
      idempotencyKey: "provider-a:ext-4",
      payloadHash: "hash-4",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "30.00", currency: "BRL" },
    });

    const rollback = WagerTransaction.create({
      id: "tx-5",
      providerId: "provider-a",
      externalTransactionId: "ext-5",
      idempotencyKey: "provider-a:ext-5",
      payloadHash: "hash-5",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Rollback,
      money: { amount: "30.00", currency: "BRL" },
      referenceExternalTransactionId: "ext-4",
    });

    expect(rollback.ledgerDirectionFor(bet)).toBe("CREDIT");
  });
});
