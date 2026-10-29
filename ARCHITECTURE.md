# Arquitetura e decisões de desenho

## 1. Objetivo

Este projeto resolve um problema real de sistemas financeiros distribuídos: manter a integridade de uma carteira digital mesmo quando mensagens são repetidas, entregues fora de ordem, processadas em paralelo ou quando há falhas temporárias no sistema.

O foco não é apenas expor endpoints de API. O foco é garantir que:

- o saldo nunca fique negativo;
- a mesma operação não seja aplicada duas vezes sem controle;
- duas transações concorrentes na mesma carteira não sobrescrevam uma a outra;
- cada alteração de saldo tenha um registro no livro contábil (ledger);
- eventos de integração só sejam emitidos depois que a transação financeira foi confirmada.

## 1.1 Autorização HTTP

As rotas financeiras e de operação usam chaves de serviço fornecidas por variáveis
de ambiente e enviadas no header `x-api-key`. `ADMIN_API_KEY` protege abertura e
reconciliação de carteiras, `PROVIDER_API_KEY` protege transações e consultas de
provedores, `API_KEY` protege consultas e `INTERNAL_API_KEY` protege operações de
fila. A identidade do provedor também precisa ser enviada em `x-provider-id` e
coincidir com o payload ou o caminho, além de estar listada em
`ALLOWED_PROVIDER_IDS`.

As mensagens recebidas diretamente da fila continuam sendo tratadas como canal
interno confiável, conforme o escopo do desafio. Endpoints HTTP de fila não devem
ser expostos publicamente e exigem `INTERNAL_API_KEY`. Em produção, endpoints SQS
não locais precisam usar HTTPS.

---

## 2. Visão geral do problema

Uma carteira de aposta funciona como uma conta financeira. Ela recebe créditos e débitos, deve respeitar regras de negócio e manter um histórico confiável.

Em sistemas distribuídos, existem três problemas clássicos:

1. Duplicação de mensagens: a mesma operação pode chegar mais de uma vez.
2. Concorrência: duas instâncias da aplicação podem tentar mexer na mesma carteira ao mesmo tempo.
3. Falha parcial: uma operação pode ser confirmada no banco, mas o evento de integração pode falhar antes de sair para a fila.

A solução precisa tratar todos esses cenários sem quebrar o saldo.

---

## 3. Modelo financeiro

### 3.1 Money (dinheiro)

`Money` é um objeto de valor (value object), ou seja, um tipo que representa um valor monetário com regras próprias. Ele encapsula:

- `amount` (quantia, como string decimal)
- `currency` (moeda, como BRL, USD, EUR)

A escolha de armazenar dinheiro como string decimal em vez de `number` é intencional. `number` em JavaScript/TypeScript usa ponto flutuante, o que pode causar erros como:

- `0.1 + 0.2` não resultar em `0.3` com precisão exata
- arredondamentos invisíveis em operações financeiras

Exemplo:

```ts
{ amount: "25.00", currency: "BRL" }
```

Isso quer dizer: 25 reais e 0 centavos, representados de forma exata.

Regras importantes do `Money`:

- aceita somente valores com escala fixa (duas casas decimais);
- rejeita entradas inválidas;
- não permite mistura de moedas em uma mesma operação;
- é imutável, ou seja, uma operação cria um novo valor em vez de alterar o existente.

### 3.2 Wallet (carteira)

A wallet é o agregado principal do domínio financeiro (aggregate root). Ela guarda:

- ID da carteira;
- ID do jogador;
- moeda da carteira;
- saldo atual;
- versão do registro.

A wallet precisa obedecer a algumas regras:

- uma pessoa não pode ter mais de uma wallet para a mesma moeda;
- o saldo nunca pode ficar negativo;
- cada ajuste de saldo precisa ser refletido no ledger;
- alterações concorrentes precisam ser controladas para evitar sobrescrita.

Exemplo de saldo:

```json
{
  "id": "wallet-123",
  "playerId": "player-456",
  "currency": "BRL",
  "balance": "100.00",
  "version": 2
}
```

### 3.3 WagerTransaction (transação de aposta)

A transação de aposta representa uma operação financeira de negócio, como:

- `BET` (aposta)
- `WIN` (ganho)
- `LOSS` (perda)
- `REFUND` (reembolso)
- `ROLLBACK` (estorno)

Cada transação tem um estado, por exemplo:

- `PENDING` (aceita, mas ainda não aplicada)
- `PENDING_REFERENCE` (aguardando a transação de referência)
- `PROCESSED` (aplicada com sucesso)
- `REJECTED` (rejeitada por regra de negócio)
- `FAILED` (erro permanente)

Uma transação terminal (processada, rejeitada ou falha) não pode ser alterada depois.

Isso é importante porque evita “estado ambíguo” e mantém a auditoria confiável.

---

## 4. Ledger (livro-razão financeiro)

O ledger é a base de auditoria do sistema. Ele registra cada movimentação da wallet de maneira imutável.

Cada item do ledger contém:

- ID da wallet;
- ID da transação que gerou o ajuste;
- direção do movimento (`DEBIT` ou `CREDIT`);
- valor movimentado;
- saldo antes;
- saldo depois;
- data da criação.

Exemplo:

```json
{
  "walletId": "wallet-123",
  "transactionId": "txn-789",
  "direction": "DEBIT",
  "amount": "60.00",
  "balanceBefore": "100.00",
  "balanceAfter": "40.00",
  "createdAt": "2026-10-28T15:00:00Z"
}
```

Esse registro é append-only (somente acrescenta). Ou seja, ele nunca é atualizado nem removido. Isso permite:

- auditar o que aconteceu;
- recalcular saldos;
- diagnosticar conflitos;
- provar que a wallet foi alterada de forma consistente.

---

## 5. Idempotência

Idempotência significa: repetir a mesma operação não deve causar efeito duplicado.

No contexto do desafio, isso é controlado por:

- `idempotencyKey` (chave única da operação)
- `payloadHash` (hash do conteúdo da operação)

Regra:

- mesma chave + mesmo payload = replay válido;
- mesma chave + payload diferente = conflito, não replay.

Exemplo:

```json
{
  "idempotencyKey": "provider-a:transaction-123",
  "payload": {
    "walletId": "wallet-123",
    "amount": "50.00",
    "kind": "BET"
  }
}
```

Se o mesmo provedor enviar a mesma operação duas vezes, o sistema retorna a mesma resposta lógica, sem debitar duas vezes.

---

## 6. Concorrência e hot wallet

Hot wallet é o nome dado a uma carteira que recebe muitas transações em paralelo. Isso é comum em sistemas de apostas, onde várias apostas e ganhos podem chegar ao mesmo tempo.

Sem controle, pode acontecer o seguinte:

1. duas transações leem o mesmo saldo antigo;
2. cada uma calcula com base no mesmo valor;
3. a segunda grava por cima da primeira.

Esse problema é chamado de lost update (atualização perdida).

Exemplo:

- saldo inicial: 100.00
- operação A: debita 60.00
- operação B: debita 50.00

Sem controle:

- A lê 100.00
- B lê 100.00
- A grava 40.00
- B grava 50.00

Resultado final incorreto: 50.00, quando o correto deveria ser 40.00 ou rejeição da segunda operação.

Para evitar isso, o sistema usa lock por wallet (bloqueio por carteira), dentro de uma transação do banco. Em SQL, essa ideia é semelhante a `SELECT ... FOR UPDATE`, que bloqueia a linha da carteira enquanto a operação está sendo processada.

---

## 7. Atomicidade financeira

A regra mais importante do sistema é a atomicidade: a alteração de saldo, o registro no ledger e o evento de integração precisam ser confirmados juntos dentro da mesma transação de banco.

Se alguma etapa falhar, tudo deve ser revertido.

Isso resolve um problema clássico:

- a wallet foi alterada;
- o ledger foi salvo;
- mas o evento de integração falhou.

Sem atomicidade, o sistema fica inconsistente e difícil de recuperar.

Esse conjunto é a base da integridade do sistema financeiro.

## 10. Reconciliação e observabilidade

A reconciliação usa o saldo materializado apenas como valor armazenado e
reconstrói o saldo somando o ledger imutável. Divergências geram resposta
inconsistente, log estruturado e métrica.

As métricas expostas em `/metrics` incluem status de transações, replays,
conflitos de payload, redelivery, retries, DLQ, conflitos de lock, latência de
processamento e atraso do outbox. Os logs são JSON e carregam identificadores
operacionais, sem registrar o valor financeiro completo da operação.

---

## 8. Outbox e Inbox

### 8.1 Outbox

Outbox é uma tabela de eventos pendentes. Quando a transação financeira foi confirmada, o sistema registra um evento de integração na tabela de outbox.

Depois, um processo de publicação pega esses eventos e os manda para a fila, como SQS.

A vantagem é clara: o evento só é publicado depois do commit, então o sistema evita inconsistência entre banco e mensageria.

Exemplo de payload de outbox:

```json
{
  "eventType": "wallet.balance.changed",
  "walletId": "wallet-123",
  "transactionId": "txn-789",
  "balanceAfter": "40.00",
  "version": 2
}
```

### 8.2 Inbox

Inbox é uma tabela que serve para deduplicar mensagens recebidas. A ideia é simples: se a mesma mensagem vier mais de uma vez, o sistema identifica que ela já foi processada.

A chave geralmente é composta por:

- nome do consumidor (consumer name)
- ID da mensagem

Isso é importante porque filas e mensagerias podem entregar a mesma mensagem mais de uma vez.

O ID usado na inbox é o identificador estável do evento (`id`/`eventId` do envelope
ou do payload), nunca o `MessageId` atribuído pelo SQS, que muda a cada publicação.
O `payload_hash` é calculado com JSON canônico recursivo, então a mesma carga com
chaves em ordem diferente é replay, enquanto a mesma mensagem com conteúdo
diferente é conflito. A gravação da inbox, o handler financeiro, o ledger e o
outbox participam da mesma transação SQL; o `ack` só ocorre depois do commit.

Este projeto não recebe webhook de gateway externo (Stripe ou equivalente). A
entrada de mensagens é o SQS, tratado como canal interno confiável, e as rotas
HTTP internas de fila usam `x-api-key`. Se um gateway externo for adicionado, a
verificação da assinatura deve acontecer sobre o corpo bruto antes do parse do
JSON.

### 8.3 Eventos versionados

Os eventos publicados pelo outbox usam subclasses de `IntegrationEvent`, cada uma
com `eventType` e `version` definidos no próprio tipo. O envelope contém
`eventId`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `version`
e `data`. Valores monetários são serializados como `{ amount, currency }`, nunca
como instâncias de `Money`.

### 8.4 Falhas e encerramento

Mensagens de negócio são reconhecidas sem retry; mensagens inválidas ou erros
permanentes são encaminhados para a DLQ após o limite configurado por
`INBOX_MAX_ATTEMPTS`. Erros transitórios permanecem invisíveis apenas durante o
visibility timeout e podem ser entregues novamente. Os workers interrompem novos
polls no `SIGTERM`, aguardam o ciclo ativo e só então encerram.

Publishers do outbox usam lock pessimista no lote selecionado. Assim, publishers
concorrentes aguardam o commit do primeiro worker e não selecionam novamente os
registros já publicados.

---

## 9. Por que a mensageria entra depois do domínio

A fila de mensagens (SQS, Kafka, Pub/Sub etc.) não resolve o problema financeiro principal. Ela apenas entrega eventos de forma assíncrona.

O projeto prioriza primeiro:

1. saldo correto;
2. ledger consistente;
3. idempotência; 
4. concorrência controlada;
5. outbox/inbox;
6. mensageria externa.

Se a base financeira não estiver correta, a mensageria só espalha inconsistência mais rápido.

Em termos práticos, a fila auxilia a comunicação entre serviços, mas o banco continua sendo a fonte da verdade.

---

## 10. Regras de negócio em resumo

- `BET` reduz o saldo e gera um ledger de débito.
- `WIN` aumenta o saldo e gera um ledger de crédito.
- `LOSS` não muda saldo, mas ainda registra o resultado da transação.
- `REFUND` e `ROLLBACK` revertendo uma operação anterior devem respeitar regras de referência.
- transações rejeitadas não alteram saldo;
- o saldo nunca pode ser negativo;
- a mesma chave idempotente com payload diferente é conflito.

---

## 11. Por que esta arquitetura é sólida

Ela atende ao que o desafio realmente exige:

- correção financeira;
- concorrência em múltiplas instâncias;
- idempotência persistente;
- consistência entre saldo materializado e ledger;
- processamento assíncrono sem perder integridade;
- recuperação após falhas e reenvios;
- clareza nas decisões técnicas.

O principal princípio é simples: manter a verdade no banco, não no cache, e tratar a fila como canal de entrega, não como garantia de consistência.

---

## 12. Decisão final de desenho

A arquitetura foi pensada para resolver o problema real do sistema financeiro distribuído:

- o banco garante integridade;
- o domínio encapsula regras;
- o ledger fornece auditoria;
- a idempotência evita efeitos duplicados;
- o lock por carteira evita lost update;
- o outbox garante que o evento de integração seja emitido depois do commit;
- o inbox evita reprocessamento duplicado de mensagens.

Essa combinação é o que torna o sistema robusto o suficiente para um desafio de arquitetura de apostas distribuídas.

## 13. Limitações e escolhas conscientes

- Autenticação não foi implementada: o README trata esse item como opcional e sem
  pontuação. Os endpoints de health permanecem públicos.
- A integração usa AWS SDK v2 porque é suficiente para o desafio e para o
  LocalStack; a aplicação registra o aviso de fim de suporte da dependência.
- O publisher do outbox publica no SQS enquanto mantém a transação e o lock do
  lote. Isso evita que dois publishers selecionem o mesmo evento, mas mantém a
  transação aberta durante a chamada externa.
- O envio ao SQS continua sendo at-least-once: se o processo cair depois da
  publicação e antes do commit, o evento pode ser publicado novamente. O
  consumidor deve ser idempotente, como o inbox implementado neste projeto.
