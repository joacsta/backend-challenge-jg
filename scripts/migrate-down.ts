import { MikroORM } from "@mikro-orm/postgresql";
import config from "../src/infrastructure/persistence/mikro-orm.config";

const orm = await MikroORM.init(config);
await orm.migrator.down();
console.log("migrations: down de um passo concluido");
await orm.close();
