# Vendas atribuídas ao criador

Recebe webhooks de pedido e de estorno no formato essencial de uma loja (campos como os da Shopify), atribui a venda a no máximo um criador e mantém o líquido de cada criador certo mesmo com pedido repetido, estorno parcial, estorno repetido e estorno que chega antes do pedido. Node 22, Hono, `node:sqlite`, TypeScript. Não conecta em loja real.

```bash
npm install
npm test        # 41 testes
npm run dev     # http://127.0.0.1:3005  (WEBHOOK_SECRET=... exige assinatura)
```

Por onde ler: `src/attribution.ts` (a regra de atribuição, num lugar só) → `src/sales.ts` (pedido, estorno, razão) → `test/`.

## Regra de atribuição e desempate

Só em `src/attribution.ts`, com testes unitários em `test/attribution.test.ts`.

| Situação | Quem leva a venda |
|---|---|
| só cupom de um criador | o dono do cupom |
| só `utm_content` de um criador | o dono do UTM |
| cupom e UTM do mesmo criador | esse criador (`coupon+utm`) |
| **cupom de A e UTM de B** | **A (o cupom vence)**; B fica em `conflict_creator_id` |
| vários cupons de criadores diferentes | o primeiro cupom da lista que tem dono |
| nenhum dos dois | ninguém (o pedido é guardado sem criador) |

Por que o cupom vence: ele foi digitado e resgatado na compra, e o desconto já foi dado em nome daquele criador. O UTM é só o último clique e pode ter sido sobrescrito por outro link. O criador do UTM não leva a venda, mas fica registrado no pedido para auditoria. A atribuição é decidida uma vez, na chegada do pedido, e não muda depois.

Cupom casa sem diferenciar maiúscula e ignora espaços; o criador do UTM vem de `utm_content` na `landing_site`.

## Pedido duplicado

O id do pedido é a chave primária. O mesmo webhook de novo devolve `200 {"status":"duplicate"}` e não grava nada: nem outra linha, nem outra venda no razão. Se a repetição vier com conteúdo diferente, nada muda e a resposta traz `"changed": true`, para alguém olhar. Pedido que não está `paid` e pedido de valor zero respondem `202 ignored` e não são atribuídos.

## Estorno

Cada estorno tem id próprio (idempotência) e `order_id`. O que acontece:

- **parcial:** reduz o líquido do criador e o pedido vira `partially_refunded`. A venda original continua lá.
- **vários:** somam. A soma dos estornos aplicados nunca passa do valor do pedido. Um estorno que passaria é **rejeitado** (`422`), mas fica gravado com o motivo (`"estorno de 170.00 passa do saldo estornável de 150.00"`), então continua rastreável. O saldo restante exato ainda pode ser estornado depois.
- **total:** zera o líquido; o pedido vira `refunded`.
- **repetido (mesmo id):** não aplica de novo, inclusive se tinha sido rejeitado. Devolve `200 duplicate` com o estado já registrado, e `changed: true` se o valor veio diferente.
- **antes do pedido:** fica `pending` (`202`) e é aplicado na hora em que o pedido chega, dentro da mesma transação. Vários pendentes são aplicados na ordem em que aconteceram (`created_at` do estorno, depois id), não na ordem em que chegaram, e o excedente é rejeitado do mesmo jeito.
- **moeda diferente da do pedido:** rejeitado.

### O histórico não é apagado

Atribuição e estorno vivem num razão só de acréscimos (`attribution_ledger`): a venda entra com valor positivo e cada estorno aplicado entra com valor negativo, ligado ao id do estorno. Nada é editado ou removido. O líquido do criador é a soma do razão; o bruto e o estornado saem do mesmo lugar.

## API

```bash
curl -s -X POST localhost:3005/creators -H 'content-type: application/json' \
  -d '{"id":"crt_ana","name":"Ana","coupon_code":"ANA10","utm_slug":"ana"}'
```

Exemplo real: estorno chega antes, depois o pedido (cupom da Ana, UTM do Bruno), depois uma repetição e um estorno grande demais.

```bash
# 1. estorno antes do pedido -> 202
curl -s -X POST localhost:3005/webhooks/refunds -H 'content-type: application/json' \
  -d '{"id":"rf_1","order_id":1001,"amount":"50.00","created_at":"2026-05-11T10:00:00Z"}'
# {"status":"pending","refund":{"id":"rf_1","order_id":"1001","amount":"50.00","status":"pending",...}}

# 2. o pedido chega -> 201, o estorno já entra aplicado
curl -s -X POST localhost:3005/webhooks/orders -H 'content-type: application/json' \
  -d '{"id":1001,"total_price":"200.00","currency":"BRL","financial_status":"paid","discount_codes":[{"code":"ANA10"}],"landing_site":"/?utm_content=bruno"}'
# {"status":"created","order":{"id":"1001","total":"200.00","currency":"BRL","status":"partially_refunded",
#   "refunded":"50.00","net":"150.00","creator_id":"crt_ana","attribution_source":"coupon","conflict_creator_id":"crt_bruno"}}

# 3. o mesmo pedido de novo -> 200 {"status":"duplicate","changed":false,...}

# 4. estorno de 170,00 quando só restam 150,00 -> 422
# {"status":"rejected","refund":{"id":"rf_2",...,"status":"rejected",
#   "reason":"estorno de 170.00 passa do saldo estornável de 150.00",...}}

curl -s localhost:3005/creators/crt_ana/sales
# {"creator":{"id":"crt_ana","name":"Ana"},"orders":1,"gross":"200.00","refunded":"50.00","net":"150.00"}
```

`GET /orders/:id` devolve o pedido, todos os estornos (inclusive pendentes e rejeitados) e as linhas do razão.

Valores são texto decimal com até 2 casas (`"199.90"`) e são guardados em centavos inteiros, sem ponto flutuante. Número no lugar do texto é recusado (`400`).

### Assinatura do webhook

Com `WEBHOOK_SECRET` definido, todo webhook precisa de `X-Shopify-Hmac-Sha256` (base64 do HMAC-SHA256 do corpo cru). Sem assinatura ou com assinatura errada, `401` e nada é gravado. Sem a variável, aceita tudo (modo desenvolvimento).

## Testes

41 testes: a regra de atribuição isolada; atribuição pelo webhook (cupom, UTM, conflito, sem dono); pedido duplicado (igual, com conteúdo diferente, id numérico e em texto); estorno parcial, várias parciais com teto, total, repetido (inclusive o rejeitado), antes do pedido (um, repetido, vários fora de ordem); moeda; entradas inválidas; centavos; assinatura. Para ter certeza de que eles pegam bug, mutei o código: tirar o teto do estorno, fazer o UTM vencer o cupom e ordenar os pendentes por id em vez de data. Os três quebram testes. Na terceira, o primeiro teste que escrevi passava mesmo com o bug (os ids estavam na mesma ordem das datas), então reescrevi com ids fora de ordem.

## O que ficou de fora

- **Só pedido pago vira venda.** Pedido `pending` é ignorado e não é guardado; se depois ele for pago, o webhook novo entra como pedido novo. Não modelei a vida do pedido (atualização de status, cancelamento, pedido editado).
- **O payload é uma versão enxuta da Shopify.** O estorno traz `amount` direto em vez de `transactions`, e o UTM vem de `utm_content` na `landing_site`. Um adaptador para o formato completo é trabalho à parte.
- **A atribuição não é recalculada.** Se o cupom ou o UTM de um criador mudar depois, os pedidos antigos continuam como estavam, o que é o certo para comissão já apurada, mas não há ferramenta de correção manual.
- **Estorno acima do saldo é rejeitado, não cortado.** Poderia ser aplicado só até o saldo; escolhi rejeitar e registrar para não esconder um dado estranho do provedor.
- **Sem comissão.** Só conto vendas brutas, estornos e líquido; não calculo percentual de criador.
- **Cadastro de criador mínimo**, sem autenticação nem edição, só o suficiente para os testes e a demonstração. Sem limite de tamanho de corpo e sem fila para webhook lento.

## Uso de IA

Usei IA para escrever o código, os testes e este README. Acompanhei o desenvolvimento, os testes passando, as mutações que quebram os testes e os exemplos acima, que são respostas reais da API rodando. O repositório não tem nenhum arquivo dirigido a ferramenta.
