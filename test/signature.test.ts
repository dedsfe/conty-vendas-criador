import { describe, expect, it } from "vitest";
import { sign } from "../src/signature.ts";
import { call, order, setup } from "./helpers.ts";

describe("assinatura do webhook", () => {
  const secret = "segredo-de-teste";
  const body = JSON.stringify(order());

  it("sem segredo configurado, aceita sem assinatura (modo desenvolvimento)", async () => {
    const app = await setup();
    expect((await call(app, "/webhooks/orders", order())).status).toBe(201);
  });

  it("com segredo, recusa sem assinatura ou com assinatura errada, e não grava nada", async () => {
    const app = await setup({ webhookSecret: secret });
    expect((await call(app, "/webhooks/orders", body)).status).toBe(401);
    expect((await call(app, "/webhooks/orders", body, "POST", { "x-shopify-hmac-sha256": sign(body, "outro") })).status).toBe(401);
    expect((await call(app, "/orders/1001", undefined, "GET")).status).toBe(404);
  });

  it("com segredo, aceita assinatura correta de pedido e de estorno", async () => {
    const app = await setup({ webhookSecret: secret });
    const ok = await call(app, "/webhooks/orders", body, "POST", { "x-shopify-hmac-sha256": sign(body, secret) });
    expect(ok.status).toBe(201);
    const refundBody = JSON.stringify({ id: "rf_1", order_id: 1001, amount: "10.00" });
    const refunded = await call(app, "/webhooks/refunds", refundBody, "POST", { "x-shopify-hmac-sha256": sign(refundBody, secret) });
    expect(refunded.status).toBe(201);
  });
});
