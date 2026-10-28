import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { migrationsList } from "../../../migrations/index.ts";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wagering:wagering@localhost:5432/wagering";

export default defineConfig({
  clientUrl: DATABASE_URL,
  entities: [],
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
