# Distributed Wagering Processor

Processador de apostas com foco em dinheiro: saldo por carteira, extrato imutável (ledger), idempotência, concorrência segura e eventos assíncronos (outbox/inbox + SQS).

Este roteiro é **copiar e colar**. Os ids são capturados automaticamente em variáveis, então não há nada para editar à mão.

## Glossário rápido

| Termo        | Significado                                                                |
| ------------ | -------------------------------------------------------------------------- |
| Money        | valor como texto decimal, ex.: `"25.00"` + moeda `BRL` (nunca float)       |
| Ledger       | extrato imutável: uma linha por mudança de saldo, com saldo antes e depois |
| Idempotência | repetir o mesmo pedido não repete o efeito                                 |
| Outbox       | eventos gravados na mesma transação do dinheiro, publicados depois         |
| Inbox        | mensagens da fila já tratadas, para não processar duas vezes               |
| Lock         | trava na carteira para duas apostas não mexerem no mesmo saldo juntas      |

## Pré-requisitos

Docker, Docker Compose, Bun, Git. Use **dois terminais** na raiz do projeto:

- **Terminal 1**: o app (fica rodando e mostra os logs).
- **Terminal 2**: todos os `curl` e consultas. As variáveis ficam salvas nele, então não feche entre os passos.

---

## Passo 1: infraestrutura (terminal 2)

```bash
docker compose up -d
docker compose ps
```

Esperado: `postgres` e `localstack` com status `Up` (healthy).

Testes de vida dos serviços:

```bash
docker compose exec postgres psql -U wagering -d wagering -c "select 1 as ok;"
curl -s http://localhost:4566/_localstack/health | head -c 300; echo
```

## Passo 2: dependências e migrations (terminal 2)

```bash
bun install
bun run scripts/migrate.ts
```

Esperado: `pendentes antes:` e `executadas agora:` listando as migrations (se vierem `[]` em banco novo, as migrations não foram encontradas: confira `migrations/index.ts`).

Confirme as tabelas:

```bash
docker compose exec postgres psql -U wagering -d wagering -c "\dt"
```

Esperado: `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`, `mikro_orm_migrations`.

## Passo 3: subir a aplicação (terminal 1)

```bash
export API_KEY=demo-read-key
export ADMIN_API_KEY=demo-admin-key
export PROVIDER_API_KEY=demo-provider-key
export INTERNAL_API_KEY=demo-internal-key
export ALLOWED_PROVIDER_IDS=provider-a
bun run src/main.ts
```

Esperado no log: `Nest application successfully started`, sem `ERROR`. A API fica em `http://localhost:3000`.

## Passo 4: preparar o terminal 2

Abra um bash (garante a mesma sintaxe para todos os comandos) e defina as variáveis e um formatador de JSON:

```bash
bash
```

```bash
export API=http://localhost:3000
export API_KEY=demo-read-key
export ADMIN_API_KEY=demo-admin-key
export PROVIDER_API_KEY=demo-provider-key
export INTERNAL_API_KEY=demo-internal-key
export RUN=$(date +%s)
export PLAYER_ID=$(cat /proc/sys/kernel/random/uuid)
pj() { python3 -m json.tool; }
psqlc() { docker compose exec -T postgres psql -U wagering -d wagering -c "$1"; }
curl() {
  local api_key="$API_KEY"
  local provider_header=()
  local command_line="$*"

  if [[ "$command_line" == *"/queues/"* ]]; then
    api_key="$INTERNAL_API_KEY"
  elif [[ "$command_line" == *"/wagering/"* || "$command_line" == *"/providers/"* ]]; then
    api_key="$PROVIDER_API_KEY"
    provider_header=(-H "x-provider-id: provider-a")
  elif [[ "$command_line" == *"-X POST"*"/wallets"* || "$command_line" == *"/reconciliation"* ]]; then
    api_key="$ADMIN_API_KEY"
  fi

  command curl -H "x-api-key: $api_key" "${provider_header[@]}" "$@"
}
echo "RUN=$RUN PLAYER_ID=$PLAYER_ID"
```

`psqlc "..."` é um atalho para rodar SQL no banco. Cada execução usa `RUN` e `PLAYER_ID` novos, então pode repetir a demo quantas vezes quiser.

O wrapper `curl` acrescenta automaticamente `x-api-key` conforme a rota e
`x-provider-id: provider-a` nas chamadas do provedor. As chaves acima são
somente credenciais locais de demonstração; em produção use valores fortes
fornecidos pelo ambiente de execução.

## Passo 5: saúde da aplicação

```bash
curl -s -w "\nHTTP %{http_code}\n" $API/health/live
curl -s -w "\nHTTP %{http_code}\n" $API/health/ready
```

Esperado: `HTTP 200`; no `ready`, `postgres` e `sqs` verdadeiros.

## Passo 6: criar uma carteira (saldo inicial 1000.00)

```bash
WALLET_JSON=$(curl -s -X POST $API/wallets \
  -H "Content-Type: application/json" \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}")
echo "$WALLET_JSON" | pj
export WALLET_ID=$(echo "$WALLET_JSON" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "WALLET_ID=$WALLET_ID"
```

Esperado: `balance 1000.00 BRL` e `version 1`. Se `WALLET_ID` sair vazio, a criação falhou: leia o JSON impresso acima.

Consulte a carteira:

```bash
curl -s $API/wallets/$WALLET_ID | pj
```

Criar de novo a carteira do mesmo jogador na mesma moeda deve dar conflito:

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wallets \
  -H "Content-Type: application/json" \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"1.00\",\"currency\":\"BRL\"}}"
```

Esperado: `HTTP 409`.

## Passo 7: criar uma aposta (BET de 25.00)

```bash
export TX_ID="transaction-$RUN"
export TX_KEY="provider-a:$TX_ID"
export BET_BODY="{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$TX_ID\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-$RUN\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $TX_KEY" \
  -d "$BET_BODY"
```

Esperado: `status PROCESSED`, `balance 975.00`, `idempotentReplay false`.

Sem o header `Idempotency-Key`, deve ser recusado:

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wagering/transactions \
  -H "Content-Type: application/json" -d "$BET_BODY"
```

Esperado: `HTTP 400`.

## Passo 8: replay idempotente (mesmo pedido de novo)

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $TX_KEY" \
  -d "$BET_BODY"
```

Esperado: o **mesmo** `transactionId`, `balance 975.00` e `idempotentReplay true`. O saldo **não** cai para 950.00.

Prove no banco que existe só um débito:

```bash
psqlc "select direction, amount, balance_before, balance_after from wallet_ledger_entries where wallet_id = '$WALLET_ID' order by seq;"
```

Esperado: 2 linhas (CREDIT 1000.00 da abertura e um único DEBIT 25.00).

## Passo 9: conflito de payload (mesma chave, valor diferente)

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $TX_KEY" \
  -d "${BET_BODY/25.00/30.00}"
```

Esperado: `HTTP 409` e mensagem de chave já usada com payload diferente.

Mesma `externalTransactionId` com **outra** chave também deve dar conflito:

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:outra-chave-$RUN" \
  -d "$BET_BODY"
```

Esperado: `HTTP 409`.

## Passo 10: histórico (ledger) e consultas

```bash
curl -s "$API/wallets/$WALLET_ID/ledger?limit=50" | pj
```

Esperado: as entradas com tipo, valor, saldo antes, saldo depois e data (a abertura de 1000.00 e o débito de 25.00).

Consultar a transação pelos dois caminhos:

```bash
curl -s $API/providers/provider-a/wagering/transactions/$TX_ID | pj
```

Para usar o id interno da transação:

```bash
export TRANSACTION_ID=$(curl -s $API/providers/provider-a/wagering/transactions/$TX_ID | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
curl -s $API/wagering/transactions/$TRANSACTION_ID | pj
```

Se `TRANSACTION_ID` sair vazio, o nome do campo no JSON é outro (provavelmente `transactionId`): olhe a resposta do comando anterior e ajuste o `grep`.

## Passo 11: saldo = soma do ledger (a invariante principal)

Direto no banco, o saldo guardado deve ser igual ao saldo reconstruído pelo extrato:

```bash
psqlc "select w.balance as saldo_guardado, coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0) as saldo_pelo_ledger from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id where w.id = '$WALLET_ID' group by w.id;"
```

Esperado: as duas colunas iguais (975.00).

Pela API de reconciliação:

```bash
curl -s -X POST $API/wallets/$WALLET_ID/reconciliation \
  -H "Content-Type: application/json" \
  -d '{"storedBalance":{"amount":"975.00","currency":"BRL"},"calculatedBalance":{"amount":"975.00","currency":"BRL"}}' | pj
```

Esperado: `consistent true`, `difference 0.00` e `checkedEntries` com o número de lançamentos.

## Passo 12: WIN e LOSS

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wagering/transactions \
  -H "Content-Type: application/json" -H "Idempotency-Key: provider-a:win-$RUN" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"win-$RUN\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-$RUN\",\"gameId\":\"fortune-chimp\",\"kind\":\"WIN\",\"money\":{\"amount\":\"50.00\",\"currency\":\"BRL\"}}"
```

Esperado: `PROCESSED`, saldo 1025.00.

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wagering/transactions \
  -H "Content-Type: application/json" -H "Idempotency-Key: provider-a:loss-$RUN" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"loss-$RUN\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-$RUN\",\"gameId\":\"fortune-chimp\",\"kind\":\"LOSS\",\"money\":{\"amount\":\"0.00\",\"currency\":\"BRL\"}}"
```

Esperado: `PROCESSED`, saldo **inalterado** e nenhum lançamento novo no ledger.

Aposta sem saldo suficiente (rejeição de negócio, não erro):

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wagering/transactions \
  -H "Content-Type: application/json" -H "Idempotency-Key: provider-a:big-$RUN" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"big-$RUN\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-$RUN\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"999999.00\",\"currency\":\"BRL\"}}"
```

Esperado: `REJECTED` com um código de falha (`INSUFFICIENT_FUNDS`), saldo inalterado.

## Passo 13: REFUND, ROLLBACK e referência fora de ordem

`REFUND` e `ROLLBACK` são processados com validação da referência, proteção contra
reversão duplicada e registro no ledger/outbox. Quando a referência ainda não
existe, a transação fica em `PENDING_REFERENCE` e o worker tenta novamente com
backoff.

Estorno da aposta do passo 7:

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wagering/transactions \
  -H "Content-Type: application/json" -H "Idempotency-Key: provider-a:refund-$RUN" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"refund-$RUN\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-$RUN\",\"gameId\":\"fortune-chimp\",\"kind\":\"REFUND\",\"referenceExternalTransactionId\":\"$TX_ID\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

Esperado: `PROCESSED` e o saldo sobe 25.00.

Reversão da mesma aposta de novo (deve ser recusada):

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wagering/transactions \
  -H "Content-Type: application/json" -H "Idempotency-Key: provider-a:refund2-$RUN" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"refund2-$RUN\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-$RUN\",\"gameId\":\"fortune-chimp\",\"kind\":\"REFUND\",\"referenceExternalTransactionId\":\"$TX_ID\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

Esperado: `REJECTED` com `ALREADY_REVERSED`.

Estorno que chega **antes** da aposta original (referência ausente):

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wagering/transactions \
  -H "Content-Type: application/json" -H "Idempotency-Key: provider-a:early-refund-$RUN" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"early-refund-$RUN\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-late\",\"gameId\":\"fortune-chimp\",\"kind\":\"REFUND\",\"referenceExternalTransactionId\":\"late-bet-$RUN\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"
```

Esperado: status `PENDING_REFERENCE`. Agora envie a aposta que faltava:

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST $API/wagering/transactions \
  -H "Content-Type: application/json" -H "Idempotency-Key: provider-a:late-bet-$RUN" \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"late-bet-$RUN\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-late\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"
```

Aguarde o worker de pendências (o primeiro retry usa backoff) e confira o estado final:

```bash
sleep 15
psqlc "select external_transaction_id, kind, status, failure_code from wager_transactions where wallet_id = '$WALLET_ID' order by created_at;"
```

Esperado: o `early-refund-...` virou `PROCESSED`.

## Passo 14: o cenário obrigatório do desafio (duas apostas simultâneas)

Carteira com 100.00 e duas apostas de 80.00 ao mesmo tempo:

```bash
export P2=$(cat /proc/sys/kernel/random/uuid)
export W2=$(curl -s -X POST $API/wallets -H "Content-Type: application/json" \
  -d "{\"playerId\":\"$P2\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "W2=$W2"
```

```bash
for i in 1 2; do
  curl -s -w "  HTTP %{http_code}\n" -X POST $API/wagering/transactions \
    -H "Content-Type: application/json" -H "Idempotency-Key: provider-a:race-$RUN-$i" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"race-$RUN-$i\",\"playerId\":\"$P2\",\"walletId\":\"$W2\",\"roundId\":\"round-race\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}" &
done
wait
```

Esperado: **exatamente uma** `PROCESSED` e **uma** `REJECTED` (saldo insuficiente). Confirme:

```bash
psqlc "select balance from wallets where id = '$W2';"
psqlc "select direction, amount, balance_before, balance_after from wallet_ledger_entries where wallet_id = '$W2' order by seq;"
```

Esperado: saldo `20.00` e o ledger com o CREDIT de abertura e **um único DEBIT**.

## Passo 15: a mesma aposta 50 vezes em paralelo

```bash
export P3=$(cat /proc/sys/kernel/random/uuid)
export W3=$(curl -s -X POST $API/wallets -H "Content-Type: application/json" \
  -d "{\"playerId\":\"$P3\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
export BODY50="{\"providerId\":\"provider-a\",\"externalTransactionId\":\"same-$RUN\",\"playerId\":\"$P3\",\"walletId\":\"$W3\",\"roundId\":\"round-same\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

```bash
seq 1 50 | xargs -P 50 -I{} curl -s -o /dev/null -w "%{http_code}\n" -X POST $API/wagering/transactions \
  -H "x-api-key: $PROVIDER_API_KEY" -H "x-provider-id: provider-a" \
  -H "Content-Type: application/json" -H "Idempotency-Key: provider-a:same-$RUN" -d "$BODY50" | sort | uniq -c
```

Esperado: nenhum `500`; o resto são respostas de sucesso e de replay. Prova no banco:

```bash
psqlc "select count(*) as debitos from wallet_ledger_entries where wallet_id = '$W3' and direction = 'DEBIT';"
psqlc "select balance from wallets where id = '$W3';"
```

Esperado: `debitos = 1` e saldo `975.00`.

## Passo 16: constraints do banco (as garantias estão no schema)

Cada comando abaixo **deve falhar**:

```bash
psqlc "insert into wallets (id, player_id, currency, balance) values (gen_random_uuid(), gen_random_uuid(), 'BRL', -1.00);"
psqlc "update wallet_ledger_entries set amount = 1.00;"
psqlc "delete from wallet_ledger_entries;"
psqlc "truncate wallet_ledger_entries;"
```

Esperado, na ordem: violação de `wallets_balance_non_negative`; e `wallet_ledger_entries is append-only` nos três últimos.

Script completo de verificação (se existir no projeto):

```bash
docker compose exec -T postgres psql -U wagering -d wagering < scripts/constraint-checks.sql
```

## Passo 17: outbox, inbox e filas

Eventos gravados na outbox (e se já foram publicados):

```bash
psqlc "select seq, event_type, attempts, published_at from outbox_messages order by seq desc limit 10;"
```

Publicar os pendentes manualmente:

```bash
curl -s -X POST $API/queues/outbox/publish \
  -H "Content-Type: application/json" -d '{"limit":10}' | pj
psqlc "select count(*) filter (where published_at is null) as pendentes, count(*) filter (where published_at is not null) as publicados from outbox_messages;"
```

Inbox: primeira vez processa, repetição é reconhecida:

```bash
for i in 1 2; do
  curl -s -X POST $API/queues/inbox/consume \
    -H "Content-Type: application/json" \
    -d "{\"consumerName\":\"demo-consumer\",\"messageId\":\"msg-$RUN\",\"payload\":{\"walletId\":\"$WALLET_ID\",\"amount\":\"25.00\"}}"
  echo
done
psqlc "select consumer_name, message_id, processed_at from inbox_messages order by received_at desc limit 5;"
```

Esperado: `false` na primeira chamada e `true` na segunda, e **uma só** linha no inbox.

Filas no emulador (o formato exato pode variar com a versão do MiniStack; se falhar, ignore):

```bash
curl -s "http://localhost:4566/?Action=ListQueues"; echo
```

## Passo 18: métricas

```bash
curl -s $API/metrics | head -40
```

Contadores esperados (os nomes podem variar): `idempotency.replay`, `idempotency.payload_conflict`, `wager.transaction.processed`, `wallet.created`.

## Passo 19: testes automatizados

```bash
bun run typecheck
bun test
```

## Se algo der errado

| Sintoma                                       | Causa provável                      | Comando / solução                                                   |
| --------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| `relation "..." does not exist` no log do app | migrations não rodaram neste banco  | `bun run scripts/migrate.ts`                                        |
| `\dt` mostra "Did not find any relations"     | banco vazio (volume novo)           | `bun run scripts/migrate.ts`                                        |
| `pendentes antes: []` em banco novo           | executor não achou as migrations    | conferir `migrations/index.ts` (`migrationsList`)                   |
| `404 Wallet not found`                        | `WALLET_ID` vazio ou de outro banco | `psqlc "select id, player_id from wallets;"`                        |
| `WALLET_ID=` vazio                            | a criação falhou                    | reler o JSON do passo 6                                             |
| `409` ao criar carteira                       | jogador já tem carteira em BRL      | gerar outro: `export PLAYER_ID=$(cat /proc/sys/kernel/random/uuid)` |
| `Connection refused` no curl                  | app não está rodando                | `bun run src/main.ts` no terminal 1                                 |
| porta 5432 ou 3000 em uso                     | outro processo usando a porta       | `docker ps` e `ss -ltnp \| grep -E '5432\|3000'`                    |
| `command not found` em `pj` ou `psqlc`        | terminal novo ou fora do bash       | rodar `bash` e refazer o passo 4                                    |

Resetar tudo (apaga os dados de desenvolvimento):

```bash
docker compose down -v
docker compose up -d
bun run scripts/migrate.ts
```

Ver logs dos serviços:

```bash
docker compose logs --tail 50 postgres
docker compose logs --tail 50 localstack
```

## Observações

- Para a demo, use carteiras novas (o passo 4 já gera um jogador novo a cada execução).
- Toda operação nova precisa de uma `Idempotency-Key` única; aqui ela é composta com `RUN`.
- O ledger não aceita `UPDATE`, `DELETE` nem `TRUNCATE`. Para zerar o ambiente, use o `down -v` acima.
