import { defineEntity, p } from "@mikro-orm/postgresql";

export const WalletEntitySchema = defineEntity({
  name: "Wallet",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary().defaultRaw("gen_random_uuid()"),
    playerId: p.uuid().fieldName("player_id"),
    currency: p.string().length(3),
    balance: p.decimal().precision(18).scale(2),
    version: p.integer().default(1),
    createdAt: p.datetime().fieldName("created_at").defaultRaw("now()"),
    updatedAt: p.datetime().fieldName("updated_at").defaultRaw("now()"),
  },
});

export class WalletEntity extends WalletEntitySchema.class {}
WalletEntitySchema.setClass(WalletEntity);
