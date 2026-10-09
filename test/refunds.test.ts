import { describe, expect, it } from "vitest";
import { call, order, refund, setup } from "./helpers.ts";

const ana = order({ discount_codes: [{ code: "ANA10" }] });
const sales = (app: Awaited<ReturnType<typeof setup>>) => call(app, "/creators/crt_ana/sales", undefined, "GET");

describe("estorno parcial", () => {
  it("reduz o líquido do criador e o status do pedido, sem apagar a venda", async () => {
    const app = await setup();
    await call(app, "/webhooks/orders", ana);
    const res = await call(app, "/webhooks/refunds", refund({ amount: "50.00" }));
    expect(res.status).toBe(201);
    expect(res.body.refund).toMatchObject({ status: "applied", amount: "50.00" });

    expect((await sales(app)).body).toMatchObject({ gross: "200.00", refunded: "50.00", net: "150.00", orders: 1 });
    const detail = await call(app, "/orders/1001", undefined, "GET");
    expect(detail.body.order).toMatchObject({ status: "partially_refunded", refunded: "50.00", net: "150.00" });
  });

  it("vários parciais somam; o que passaria do valor da venda é rejeitado e fica registrado", async () => {
    const app = await setup();
    await call(app, "/webhooks/orders", ana); // 200,00
    await call(app, "/webhooks/refunds", refund({ id: "rf_1", amount: "120.00" }));
    await call(app, "/webhooks/refunds", refund({ id: "rf_2", amount: "70.00" })); // total 190
    const over = await call(app, "/webhooks/refunds", refund({ id: "rf_3", amount: "20.00" })); // 210 > 200
    expect(over.status).toBe(422);
    expect(over.body.refund).toMatchObject({ status: "rejected" });
    expect(over.body.refund.reason).toContain("10.00");

    const detail = await call(app, "/orders/1001", undefined, "GET");
    expect(detail.body.order.refunded).toBe("190.00");
    expect(detail.body.refunds.map((r: any) => [r.id, r.status])).toEqual([
      ["rf_1", "applied"],
      ["rf_2", "applied"],
      ["rf_3", "rejected"],
    ]);
    expect((await sales(app)).body.net).toBe("10.00");
    // o resto exato ainda pode ser estornado
    expect((await call(app, "/webhooks/refunds", refund({ id: "rf_4", amount: "10.00" }))).status).toBe(201);
    expect((await sales(app)).body.net).toBe("0.00");
  });
});

describe("estorno total", () => {
  it("zera o líquido e mantém o histórico completo no razão", async () => {
    const app = await setup();
    await call(app, "/webhooks/orders", ana);
    await call(app, "/webhooks/refunds", refund({ amount: "200.00" }));

    expect((await sales(app)).body).toMatchObject({ gross: "200.00", refunded: "200.00", net: "0.00" });
    const detail = await call(app, "/orders/1001", undefined, "GET");
    expect(detail.body.order.status).toBe("refunded");
    expect(detail.body.ledger.map((e: any) => [e.kind, e.sign + e.amount])).toEqual([
      ["sale", "+200.00"],
      ["refund", "-200.00"],
    ]);
  });
});

describe("estorno repetido", () => {
  it("o mesmo estorno duas vezes só vale uma", async () => {
    const app = await setup();
    await call(app, "/webhooks/orders", ana);
    expect((await call(app, "/webhooks/refunds", refund())).status).toBe(201);
    const again = await call(app, "/webhooks/refunds", refund());
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "duplicate", changed: false });
    expect((await sales(app)).body.net).toBe("150.00");
    expect((await call(app, "/orders/1001", undefined, "GET")).body.refunds).toHaveLength(1);
  });

  it("repetição de estorno que tinha sido rejeitado continua rejeitada, sem reaplicar", async () => {
    const app = await setup();
    await call(app, "/webhooks/orders", ana);
    await call(app, "/webhooks/refunds", refund({ id: "big", amount: "500.00" }));
    const again = await call(app, "/webhooks/refunds", refund({ id: "big", amount: "500.00" }));
    expect(again.body).toMatchObject({ status: "duplicate", refund: { status: "rejected" } });
    expect((await sales(app)).body.net).toBe("200.00");
  });

  it("mesmo id com valor diferente não altera nada e avisa changed: true", async () => {
    const app = await setup();
    await call(app, "/webhooks/orders", ana);
    await call(app, "/webhooks/refunds", refund({ amount: "50.00" }));
    const again = await call(app, "/webhooks/refunds", refund({ amount: "80.00" }));
    expect(again.body).toMatchObject({ status: "duplicate", changed: true });
    expect((await sales(app)).body.net).toBe("150.00");
  });
});

describe("estorno que chega antes do pedido", () => {
  it("fica pendente e é aplicado quando o pedido chega", async () => {
    const app = await setup();
    const early = await call(app, "/webhooks/refunds", refund({ amount: "50.00" }));
    expect(early.status).toBe(202);
    expect(early.body.refund.status).toBe("pending");
    expect((await call(app, "/orders/1001", undefined, "GET")).body).toMatchObject({
      order: null,
      refunds: [{ id: "rf_1", status: "pending" }],
    });

    const created = await call(app, "/webhooks/orders", ana);
    expect(created.status).toBe(201);
    expect(created.body.order).toMatchObject({ refunded: "50.00", net: "150.00", status: "partially_refunded" });

    expect((await sales(app)).body).toMatchObject({ gross: "200.00", refunded: "50.00", net: "150.00" });
    const detail = await call(app, "/orders/1001", undefined, "GET");
    expect(detail.body.refunds[0]).toMatchObject({ status: "applied" });
    expect(detail.body.refunds[0].applied_at).not.toBeNull();
  });

  it("repetir o estorno pendente não cria um segundo", async () => {
    const app = await setup();
    await call(app, "/webhooks/refunds", refund());
    expect((await call(app, "/webhooks/refunds", refund())).body.status).toBe("duplicate");
    await call(app, "/webhooks/orders", ana);
    expect((await sales(app)).body.net).toBe("150.00");
  });

  it("vários pendentes são aplicados na ordem em que aconteceram e o excedente é rejeitado", async () => {
    const app = await setup();
    // Os ids NÃO seguem a ordem das datas, de propósito: ordenar por id daria outro resultado.
    // Pela data: rf_c (10/05, 120) -> rf_b (11/05, 70) -> rf_a (12/05, 100, passaria de 200).
    await call(app, "/webhooks/refunds", refund({ id: "rf_a", amount: "100.00", created_at: "2026-05-12T10:00:00Z" }));
    await call(app, "/webhooks/refunds", refund({ id: "rf_b", amount: "70.00", created_at: "2026-05-11T10:00:00Z" }));
    await call(app, "/webhooks/refunds", refund({ id: "rf_c", amount: "120.00", created_at: "2026-05-10T10:00:00Z" }));
    await call(app, "/webhooks/orders", ana);

    const detail = await call(app, "/orders/1001", undefined, "GET");
    expect(detail.body.refunds.map((r: any) => [r.id, r.status])).toEqual([
      ["rf_c", "applied"],
      ["rf_b", "applied"],
      ["rf_a", "rejected"],
    ]);
    expect(detail.body.order).toMatchObject({ refunded: "190.00", net: "10.00" });
  });

  it("estorno pendente de pedido que nunca chega não afeta ninguém", async () => {
    const app = await setup();
    await call(app, "/webhooks/refunds", refund({ order_id: 9999 }));
    expect((await sales(app)).body).toMatchObject({ gross: "0.00", net: "0.00" });
  });
});

describe("outros casos de estorno", () => {
  it("pedido sem criador aceita estorno, e o razão de ninguém muda", async () => {
    const app = await setup();
    await call(app, "/webhooks/orders", order());
    expect((await call(app, "/webhooks/refunds", refund({ amount: "30.00" }))).status).toBe(201);
    const detail = await call(app, "/orders/1001", undefined, "GET");
    expect(detail.body.order).toMatchObject({ refunded: "30.00", creator_id: null });
    expect(detail.body.ledger).toEqual([]);
  });

  it("recusa estorno em moeda diferente da do pedido", async () => {
    const app = await setup();
    await call(app, "/webhooks/orders", ana);
    const res = await call(app, "/webhooks/refunds", refund({ currency: "USD" }));
    expect(res.status).toBe(422);
    expect((await sales(app)).body.net).toBe("200.00");
  });

  it.each([
    ["sem id", { id: undefined }],
    ["sem order_id", { order_id: undefined }],
    ["valor zero", { amount: "0.00" }],
    ["valor negativo", { amount: "-1.00" }],
    ["valor numérico", { amount: 50 }],
  ])("recusa estorno %s", async (_name, overrides) => {
    const app = await setup();
    await call(app, "/webhooks/orders", ana);
    expect((await call(app, "/webhooks/refunds", refund(overrides))).status).toBe(400);
  });
});
