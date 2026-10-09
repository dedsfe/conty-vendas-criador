import { describe, expect, it } from "vitest";
import { call, order, setup } from "./helpers.ts";

const ana = order({ discount_codes: [{ code: "ANA10" }] });

describe("pedido duplicado", () => {
  it("o mesmo webhook duas vezes não soma a venda de novo", async () => {
    const app = await setup();
    expect((await call(app, "/webhooks/orders", ana)).status).toBe(201);
    const again = await call(app, "/webhooks/orders", ana);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "duplicate", changed: false });

    const sales = await call(app, "/creators/crt_ana/sales", undefined, "GET");
    expect(sales.body).toMatchObject({ orders: 1, gross: "200.00", net: "200.00" });
    const detail = await call(app, "/orders/1001", undefined, "GET");
    expect(detail.body.ledger).toHaveLength(1);
  });

  it("repetição com conteúdo diferente não altera nada, mas avisa changed: true", async () => {
    const app = await setup();
    await call(app, "/webhooks/orders", ana);
    const again = await call(app, "/webhooks/orders", { ...ana, total_price: "999.00", discount_codes: [{ code: "BRUNO10" }] });
    expect(again.body).toMatchObject({ status: "duplicate", changed: true });
    expect(again.body.order).toMatchObject({ total: "200.00", creator_id: "crt_ana" });
  });

  it("id numérico e id em texto são o mesmo pedido", async () => {
    const app = await setup();
    await call(app, "/webhooks/orders", ana);
    expect((await call(app, "/webhooks/orders", { ...ana, id: "1001" })).body.status).toBe("duplicate");
  });
});

describe("entrada inválida", () => {
  it.each([
    ["sem id", { id: undefined }],
    ["total com vírgula", { total_price: "12,50" }],
    ["total negativo", { total_price: "-5.00" }],
    ["total como número", { total_price: 12.5 }],
    ["total com 3 casas", { total_price: "10.999" }],
    ["sem moeda", { currency: undefined }],
    ["sem status", { financial_status: undefined }],
  ])("recusa pedido %s", async (_name, overrides) => {
    const app = await setup();
    const res = await call(app, "/webhooks/orders", order(overrides));
    expect(res.status).toBe(400);
    expect((await call(app, "/orders/1001", undefined, "GET")).status).toBe(404);
  });

  it("recusa corpo que não é JSON de objeto", async () => {
    const app = await setup();
    expect((await call(app, "/webhooks/orders", "não é json")).status).toBe(400);
    expect((await call(app, "/webhooks/orders", "[1,2]")).status).toBe(400);
  });

  it("pedido não pago e pedido de valor zero são ignorados, sem atribuir", async () => {
    const app = await setup();
    const pending = await call(app, "/webhooks/orders", { ...ana, financial_status: "pending" });
    const free = await call(app, "/webhooks/orders", order({ id: 7, total_price: "0.00" }));
    expect([pending.status, free.status]).toEqual([202, 202]);
    expect((await call(app, "/creators/crt_ana/sales", undefined, "GET")).body.orders).toBe(0);
  });
});

describe("dinheiro em centavos", () => {
  it("não perde centavo com valores que dão problema em ponto flutuante", async () => {
    const app = await setup();
    await call(app, "/webhooks/orders", order({ id: 1, total_price: "0.10", discount_codes: [{ code: "ANA10" }] }));
    await call(app, "/webhooks/orders", order({ id: 2, total_price: "0.20", discount_codes: [{ code: "ANA10" }] }));
    await call(app, "/webhooks/orders", order({ id: 3, total_price: "19.9", discount_codes: [{ code: "ANA10" }] }));
    expect((await call(app, "/creators/crt_ana/sales", undefined, "GET")).body.gross).toBe("20.20");
  });
});
