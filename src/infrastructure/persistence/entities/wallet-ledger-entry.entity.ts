import { defineEntity, p } from "@mikro-orm/postgresql";

export const WalletLedgerEntryEntitySchema = defineEntity({
  name: "WalletLedgerEntry",
  tableName: "wallet_ledger_entries",
  properties: {
    seq: p.bigint().nullable().fieldName("seq"),
    id: p.uuid().primary().defaultRaw("gen_random_uuid()"),
    walletId: p.uuid().fieldName("wallet_id"),
    transactionId: p.uuid().fieldName("transaction_id"),
    direction: p.string(),
    amount: p.decimal().precision(18).scale(2),
    currency: p.string().length(3),
    balanceBefore: p
      .decimal()
      .precision(18)
      .scale(2)
      .fieldName("balance_before"),
    balanceAfter: p.decimal().precision(18).scale(2).fieldName("balance_after"),
    createdAt: p.datetime().fieldName("created_at").defaultRaw("now()"),
  },
  indexes: [
    {
      name: "ledger_wallet_seq_idx",
      properties: ["walletId"],
    },
  ],
});

export class WalletLedgerEntryEntity
  extends WalletLedgerEntryEntitySchema.class {}
WalletLedgerEntryEntitySchema.setClass(WalletLedgerEntryEntity);
