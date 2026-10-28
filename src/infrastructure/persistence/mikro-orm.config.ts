import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { migrationsList } from "../../../migrations/index.ts";
import { WalletEntity } from "./entities/wallet.entity";
import { WagerTransactionEntity } from "./entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "./entities/wallet-ledger-entry.entity";
import { InboxMessageEntity } from "./entities/inbox-message.entity";
import { OutboxMessageEntity } from "./entities/outbox-message.entity";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wagering:wagering@localhost:5432/wagering";

export default defineConfig({
  clientUrl: DATABASE_URL,
  entities: [
    WalletEntity,
    WagerTransactionEntity,
    WalletLedgerEntryEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    path: "./migrations",
    glob: "!(*.d).{js,ts,cjs}",
    emit: "ts",
    transactional: true,
    migrationsList,
  },
});
