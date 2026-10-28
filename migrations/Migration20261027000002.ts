import { Migration } from "@mikro-orm/migrations";

export class Migration20261027000002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
CREATE TABLE wager_transactions (
id                                uuid PRIMARY KEY,
provider_id                       text NOT NULL,
external_transaction_id           text NOT NULL,
idempotency_key                   text NOT NULL,
payload_hash                      char(64) NOT NULL,
wallet_id                         uuid NOT NULL REFERENCES wallets(id),
player_id                         uuid NOT NULL,
round_id                          text NOT NULL,
game_id                           text NOT NULL,
kind                              text NOT NULL,
amount                            numeric(18,2) NOT NULL,
currency                          char(3) NOT NULL,
reference_external_transaction_id text,
reference_transaction_id          uuid REFERENCES wager_transactions(id),
status                            text NOT NULL,
failure_code                      text,
observed_balance                  numeric(18,2),
attempts                          integer NOT NULL DEFAULT 0,
next_attempt_at                   timestamptz,
created_at                        timestamptz NOT NULL DEFAULT now(),
processed_at                      timestamptz,
CONSTRAINT wt_idempotency_uq UNIQUE (idempotency_key),
CONSTRAINT wt_external_uq    UNIQUE (provider_id, external_transaction_id),
CONSTRAINT wt_kind_ck   CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
CONSTRAINT wt_status_ck CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
CONSTRAINT wt_amount_ck CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
CONSTRAINT wt_ref_required_ck  CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
CONSTRAINT wt_ref_forbidden_ck CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
CONSTRAINT wt_failure_ck   CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
CONSTRAINT wt_processed_ck CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL))
);`);

    this.addSql(`
CREATE UNIQUE INDEX wt_single_reversal_uq
ON wager_transactions (reference_transaction_id)
WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');`);

    this.addSql(`
CREATE INDEX wt_pending_reference_idx
ON wager_transactions (next_attempt_at) WHERE status = 'PENDING_REFERENCE';`);

    this.addSql(`
CREATE FUNCTION wt_forbid_terminal_change() RETURNS trigger AS $$
BEGIN
IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
RAISE EXCEPTION 'wager_transactions: terminal status % cannot change', OLD.status;
END IF;
RETURN NEW;
END; $$ LANGUAGE plpgsql;`);

    this.addSql(`
CREATE TRIGGER wt_terminal_guard BEFORE UPDATE ON wager_transactions
FOR EACH ROW EXECUTE FUNCTION wt_forbid_terminal_change();`);

    this.addSql(`
CREATE TABLE wallet_ledger_entries (
seq            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
id             uuid PRIMARY KEY,
wallet_id      uuid NOT NULL REFERENCES wallets(id),
transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
direction      text NOT NULL,
amount         numeric(18,2) NOT NULL,
currency       char(3) NOT NULL,
balance_before numeric(18,2) NOT NULL,
balance_after  numeric(18,2) NOT NULL,
created_at     timestamptz NOT NULL DEFAULT now(),
CONSTRAINT ledger_one_entry_per_tx_uq UNIQUE (wallet_id, transaction_id),
CONSTRAINT ledger_direction_ck CHECK (direction IN ('DEBIT','CREDIT')),
CONSTRAINT ledger_amount_ck    CHECK (amount > 0),
CONSTRAINT ledger_balances_ck  CHECK (balance_before >= 0 AND balance_after >= 0),
CONSTRAINT ledger_arithmetic_ck CHECK (
(direction = 'CREDIT' AND balance_after = balance_before + amount) OR
(direction = 'DEBIT'  AND balance_after = balance_before - amount))
);`);

    this.addSql(
      `CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq);`,
    );

    this.addSql(`
CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'wallet_ledger_entries is append-only'; END; $$ LANGUAGE plpgsql;`);

    this.addSql(`
CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation();`);

    this.addSql(`
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_mutation();`);

    this.addSql(`
CREATE TABLE inbox_messages (
consumer_name text NOT NULL,
message_id    text NOT NULL,
payload_hash  char(64) NOT NULL,
received_at   timestamptz NOT NULL DEFAULT now(),
processed_at  timestamptz,
PRIMARY KEY (consumer_name, message_id)
);`);

    this.addSql(`
CREATE TABLE outbox_messages (
seq             bigint GENERATED ALWAYS AS IDENTITY,
id              uuid PRIMARY KEY,
aggregate_id    uuid NOT NULL,
event_type      text NOT NULL,
payload         jsonb NOT NULL,
occurred_at     timestamptz NOT NULL,
attempts        integer NOT NULL DEFAULT 0,
next_attempt_at timestamptz NOT NULL DEFAULT now(),
published_at    timestamptz
);`);

    this.addSql(`
CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop function if exists ledger_forbid_mutation();`);
    this.addSql(`drop function if exists wt_forbid_terminal_change();`);
  }
}
