-- SETUP: uma carteira, uma aposta processada e o lançamento correspondente
insert into wallets (id, player_id, currency, balance)
values ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'BRL', 20.00);

insert into wager_transactions
    (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
    round_id, game_id, kind, amount, currency, status, processed_at, observed_balance)
values
    ('00000000-0000-0000-0000-0000000000b1', 'p', 't1', 'p:t1', repeat('a', 64),
    '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1',
    'r1', 'g1', 'BET', 80.00, 'BRL', 'PROCESSED', now(), 20.00);

insert into wallet_ledger_entries
    (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
values
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-0000000000b1', 'DEBIT', 80.00, 'BRL', 100.00, 20.00);

-- A PARTIR DAQUI, CADA COMANDO DEVE FALHAR

-- saldo negativo
insert into wallets (id, player_id, currency, balance) values (gen_random_uuid(), gen_random_uuid(), 'BRL', -1.00);

-- segunda carteira do mesmo jogador na mesma moeda
insert into wallets (id, player_id, currency, balance)
values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', 'BRL', 5.00);

-- mesma idempotency_key com outro externalTransactionId
insert into wager_transactions
    (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
    round_id, game_id, kind, amount, currency, status)
values
    (gen_random_uuid(), 'p', 't2', 'p:t1', repeat('b', 64),
    '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1',
    'r1', 'g1', 'BET', 10.00, 'BRL', 'PENDING');

-- REFUND sem referência
insert into wager_transactions
    (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
    round_id, game_id, kind, amount, currency, status)
values
    (gen_random_uuid(), 'p', 't3', 'p:t3', repeat('c', 64),
    '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1',
    'r1', 'g1', 'REFUND', 10.00, 'BRL', 'PENDING');

-- lançamento com a conta errada (débito de 80 de 100 não dá 50)
insert into wallet_ledger_entries
    (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
values
    (gen_random_uuid(), '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-0000000000b1', 'DEBIT', 80.00, 'BRL', 100.00, 50.00);

-- segundo lançamento para a mesma transação (conta certa)
insert into wallet_ledger_entries
    (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
values
    (gen_random_uuid(), '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-0000000000b1', 'DEBIT', 80.00, 'BRL', 100.00, 20.00);

-- alterar, apagar e truncar o ledger
update wallet_ledger_entries set amount = 1.00;
delete from wallet_ledger_entries;
truncate wallet_ledger_entries;

-- transação PROCESSED voltando para PENDING
update wager_transactions set status = 'PENDING', processed_at = null
where id = '00000000-0000-0000-0000-0000000000b1';
