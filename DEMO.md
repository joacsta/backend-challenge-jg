# Documentação de demonstração do projeto

## Introdução

Este projeto simula um processador de apostas distribuído, com foco em dinheiro real, contas de usuário e eventos assíncronos.

Em termos simples:
- ele cuida do saldo da carteira
- registra tudo que entra e sai
- evita que a mesma aposta seja processada duas vezes
- evita erros por concorrência, quando duas pessoas tentam mexer no mesmo saldo ao mesmo tempo
- envia eventos para fila para processamento assíncrono

Importante:
- o projeto não usa float para dinheiro
- usa decimal/strings para evitar erro de cálculo
- o saldo e os registros contábeis são protegidos no banco de dados

## Termos técnicos explicados em linguagem simples

- Money: valor monetário, como "25.00 BRL"
- Ledger: registro contábil, tipo "histórico de movimentação da carteira"
- Idempotência: "se a mesma operação chegar duas vezes, o sistema trata como a mesma coisa"
- Outbox: "lista de eventos que precisam ser enviados depois da transação"
- Inbox: "lista de mensagens recebidas para evitar reprocessamento"
- SQS: fila de mensagens, como uma fila de trabalho
- PostgreSQL: banco de dados relacional
- LocalStack: ferramenta que simula serviços AWS locais
- Lock: trava temporária para evitar conflito ao mexer no mesmo saldo ao mesmo tempo

## Objetivo da demo

Verificar que:
- uma carteira pode ser criada
- uma aposta pode ser processada
- a mesma aposta não duplica efeito
- o mesmo payload com a mesma chave não pode ser aceito se for diferente
- o saldo final permanece consistente
- eventos saem para fila e podem ser processados depois

## Pré-requisitos

- Docker
- Docker Compose
- Bun
- Git

## Estrutura do projeto

A parte principal está em:
- src/application: regras de negócio
- src/domain: regras centrais do domínio
- src/infrastructure: banco, filas, infraestrutura
- migrations: criação das tabelas no banco
- docker-compose.yml: sobe PostgreSQL e LocalStack

## Passo 1: subir infraestrutura

Na raiz do projeto, rode:

```bash
docker compose up -d
```

Esse comando sobe:
- PostgreSQL
- LocalStack

Esses serviços são usados para simular o ambiente real do projeto.

## Passo 2: verificar se os serviços subiram

Você pode testar com:

```bash
docker compose ps
```

Também pode testar o banco com:
- Postgres em localhost:5432
- LocalStack em localhost:4566

## Passo 3: instalar dependências do projeto

Se ainda não estiverem instaladas:

```bash
bun install
```

## Passo 4: iniciar a aplicação

No terminal da raiz:

```bash
bun run src/main.ts
```

Se tudo estiver ok, a API ficará disponível em:
- http://localhost:3000

## Passo 5: verificar saúde da aplicação

Teste:

```bash
curl http://localhost:3000/health/ready
```

Resposta esperada:
- status ok
- postgres true
- sqs true

Isso quer dizer que:
- o banco está acessível
- a fila está acessível

## Passo 6: criar uma carteira

Endpoint:

```http
POST /wallets
```

Exemplo de body:

```json
{
  "playerId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "initialBalance": {
    "amount": "1000.00",
    "currency": "BRL"
  }
}
```

Comando curl:

```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{"playerId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Resposta esperada:
- id da carteira
- playerId
- balance: 1000.00 BRL
- version: 1

O que isso significa:
- a carteira foi criada
- o saldo inicial foi registrado
- a versão inicial da carteira começa em 1

## Passo 7: criar uma aposta

Endpoint:

```http
POST /wagering/transactions
```

Importante:
- O header Idempotency-Key é obrigatório
- Ele serve para identificar que a operação é a mesma
- Isso evita que a mesma aposta seja duplicada

Exemplo de header:

```http
Idempotency-Key: provider-a:transaction-live-2
```

Exemplo de body:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-live-2",
  "playerId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "walletId": "SUA_WALLET_ID_AQUI",
  "roundId": "round-live",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": {
    "amount": "25.00",
    "currency": "BRL"
  }
}
```

Comando curl:

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:transaction-live-2" \
  -d '{
    "providerId":"provider-a",
    "externalTransactionId":"transaction-live-2",
    "playerId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "walletId":"SUA_WALLET_ID_AQUI",
    "roundId":"round-live",
    "gameId":"fortune-chimp",
    "kind":"BET",
    "money":{"amount":"25.00","currency":"BRL"}
  }'
```

Resposta esperada:
- transactionId
- status: PROCESSED
- balance: 975.00 BRL
- idempotentReplay: false

Isso quer dizer:
- a aposta foi aceita
- 25.00 foram debitados da carteira
- o saldo agora é 975.00

## Passo 8: testar replay idempotente

Faça a mesma requisição exatamente igual, com o mesmo Idempotency-Key.

Resposta esperada:
- o mesmo transactionId
- status: PROCESSED
- balance: 975.00 BRL
- idempotentReplay: true

Isso quer dizer:
- a operação foi reconhecida como repetição da mesma ação
- o sistema não executou de novo o débito

## Passo 9: testar conflito de payload

Use a mesma Idempotency-Key, mas mude o valor do dinheiro.

Exemplo:
- primeiro request: 25.00
- segundo request: 30.00

Mesmo Idempotency-Key, payload diferente.

Resposta esperada:
- HTTP 409 Conflict
- mensagem: Idempotency key already used with different payload

Isso é importante porque garante que:
- não pode reutilizar a mesma chave para outra operação sem autorização
- isso evita inconsistência

## Passo 10: verificar o histórico da carteira

Endpoint:

```http
GET /wallets/:walletId/ledger
```

Comando:

```bash
curl http://localhost:3000/wallets/SUA_WALLET_ID_AQUI/ledger
```

Resposta esperada:
- histórico de entradas e saídas
- cada linha com:
  - tipo de movimentação
  - valor
  - saldo antes
  - saldo depois
  - data

Isso mostra que tudo foi registrado de forma auditável.

## Passo 11: verificar reconciliação

Endpoint:

```http
POST /wallets/:walletId/reconciliation
```

Exemplo:

```json
{
  "storedBalance": { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" }
}
```

Comando:

```bash
curl -X POST http://localhost:3000/wallets/SUA_WALLET_ID_AQUI/reconciliation \
  -H "Content-Type: application/json" \
  -d '{"storedBalance":{"amount":"975.00","currency":"BRL"},"calculatedBalance":{"amount":"975.00","currency":"BRL"}}'
```

Resposta esperada:
- consistent: true
- difference: 0.00
- checkedEntries: X

Isso confirma que o saldo guardado no banco bate com o saldo calculado pelo histórico.

## Passo 12: verificar outbox e inbox

O projeto trabalha com filas para processamento assíncrono.

### Outbox
- guarda eventos pendentes depois da transação
- depois são enviados para a fila

### Inbox
- guarda mensagens recebidas
- evita processamento duplicado

Você pode testar manualmente:
- POST /queues/outbox/publish
- POST /queues/inbox/consume

### Exemplo de outbox

```bash
curl -X POST http://localhost:3000/queues/outbox/publish \
  -H "Content-Type: application/json" \
  -d '{"limit":10}'
```

Resposta esperada:
- lista de eventos publicados
- cada evento com status e tentativa

### Exemplo de inbox

```bash
curl -X POST http://localhost:3000/queues/inbox/consume \
  -H "Content-Type: application/json" \
  -d '{"consumerName":"demo-consumer","messageId":"msg-live-1","payload":{"walletId":"SUA_WALLET_ID_AQUI","amount":"25.00"}}'
```

Resposta esperada:
- false em primeiro processamento
- true em repetição

Explicando: isso significa que a primeira vez processa; a segunda vez reconhece que já foi consumida.

## Passo 13: verificar métricas

Endpoint:

```http
GET /metrics
```

Essa rota mostra contadores internos, por exemplo:
- idempotency.replay
- idempotency.payload_conflict
- wager.transaction.processed
- wallet.created

Isso ajuda a saber o que aconteceu no sistema sem olhar o banco diretamente.

## Passo 14: cenário de sucesso esperado

Se tudo estiver funcionando, a sequência correta é:
1. cria wallet
2. cria aposta
3. saldo cai
4. ledger registra movimento
5. outbox cria evento
6. evento sai para fila
7. replay com mesma chave retorna mesma resposta
8. payload diferente com mesma chave falha
9. reconciliação confirma saldo correto

## Resumo final

Esse projeto é uma simulação de um sistema financeiro distribuído com foco em:
- integridade de dinheiro
- segurança de transações
- concorrência
- falha de processamento
- processamento assíncrono

O ponto mais importante é:
- mesmo quando algo acontece em paralelo ou chega duas vezes, o sistema tenta manter o saldo correto e o histórico confiável

## Observações finais

- Para a demo, é melhor usar wallets novas para evitar confusão com saldos de outras execuções
- Sempre use um Idempotency-Key único para cada operação nova
- O projeto foi pensado para ser correto financeiramente antes de ser um sistema de produção completo

## Dica extra

Se quiser automatizar a demo, você pode rodar uma sequência de comandos em shell e validar cada etapa em ordem. O objetivo principal é observar que o sistema se comporta corretamente mesmo com duplicidade e concorrência.
