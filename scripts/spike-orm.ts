import { MikroORM, defineConfig } from "@mikro-orm/postgresql";

const orm = await MikroORM.init(
  defineConfig({
    clientUrl: "postgresql://wagering:wagering@localhost:5432/wagering",
    entities: [],
    discovery: { warnWhenNoEntities: false },
  }),
);
const em = orm.em.fork();

const rows = await em.execute("select 15.50::numeric(18,2) as amount, 1 as ok");
console.log("result: ", rows);
console.log("amount type: ", typeof rows[0]?.amount);

await em.transactional(async (tx) => {
  const inTx = await tx.execute("select 1 as ok");
  console.log("dentro da transacao: ", inTx);
});

await orm.close();
