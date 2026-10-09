import { describe, expect, it } from "vitest";
import { attribute } from "../src/attribution.ts";
import { call, order, setup } from "./helpers.ts";

describe("regra de atribuição (unitária)", () => {
  it("sem cupom e sem utm não atribui", () => {
    expect(attribute({ couponCreatorIds: [], utmCreatorId: null })).toEqual({
      creator_id: null,
      source: null,
      conflict_creator_id: null,
    });
    expect(attribute({ couponCreatorIds: [null], utmCreatorId: null }).creator_id).toBeNull();
  });

  it("só cupom, só utm, ou os dois apontando para o mesmo criador", () => {
    expect(attribute({ couponCreatorIds: ["a"], utmCreatorId: null })).toMatchObject({ creator_id: "a", source: "coupon" });
    expect(attribute({ couponCreatorIds: [], utmCreatorId: "b" })).toMatchObject({ creator_id: "b", source: "utm" });
    expect(attribute({ couponCreatorIds: ["a"], utmCreatorId: "a" })).toMatchObject({ creator_id: "a", source: "coupon+utm" });
  });

  it("cupom e utm de criadores diferentes: o cupom vence e o utm fica registrado como conflito", () => {
    expect(attribute({ couponCreatorIds: ["a"], utmCreatorId: "b" })).toEqual({
      creator_id: "a",
      source: "coupon",
      conflict_creator_id: "b",
    });
  });

  it("cupom sem dono não impede o utm; com vários cupons vale o primeiro com dono", () => {
    expect(attribute({ couponCreatorIds: [null], utmCreatorId: "b" })).toMatchObject({ creator_id: "b", source: "utm" });
    expect(attribute({ couponCreatorIds: [null, "a", "c"], utmCreatorId: null }).creator_id).toBe("a");
  });
});

describe("atribuição pelo webhook", () => {
  it("por cupom, sem diferenciar maiúscula de minúscula", async () => {
    const app = await setup();
    const res = await call(app, "/webhooks/orders", order({ discount_codes: [{ code: " ana10 " }] }));
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ creator_id: "crt_ana", attribution_source: "coupon" });
  });

  it("por utm_content da landing_site", async () => {
    const app = await setup();
    const res = await call(app, "/webhooks/orders", order({ landing_site: "/products/x?utm_source=ig&utm_content=Bruno" }));
    expect(res.body.order).toMatchObject({ creator_id: "crt_bruno", attribution_source: "utm" });
  });

  it("cupom da Ana e utm do Bruno: a venda é da Ana e o Bruno fica como conflito", async () => {
    const app = await setup();
    const res = await call(
      app,
      "/webhooks/orders",
      order({ discount_codes: [{ code: "ANA10" }], landing_site: "/?utm_content=bruno" }),
    );
    expect(res.body.order).toMatchObject({
      creator_id: "crt_ana",
      attribution_source: "coupon",
      conflict_creator_id: "crt_bruno",
    });
    const bruno = await call(app, "/creators/crt_bruno/sales", undefined, "GET");
    expect(bruno.body).toMatchObject({ orders: 0, gross: "0.00", net: "0.00" });
  });

  it("pedido sem cupom nem utm é guardado sem criador e não entra em venda de ninguém", async () => {
    const app = await setup();
    const res = await call(app, "/webhooks/orders", order({ discount_codes: [{ code: "OUTRO" }] }));
    expect(res.status).toBe(201);
    expect(res.body.order.creator_id).toBeNull();
    expect((await call(app, "/creators/crt_ana/sales", undefined, "GET")).body.gross).toBe("0.00");
  });
});
