import { MikroORM } from "@mikro-orm/postgresql";
import config from "../src/infrastructure/persistence/mikro-orm.config";

const orm = await MikroORM.init(config);

const pending = await orm.migrator.getPending();
console.log("pendentes antes:", pending);

const ran = await orm.migrator.up();
console.log("executadas agora:", ran);

await orm.close();
