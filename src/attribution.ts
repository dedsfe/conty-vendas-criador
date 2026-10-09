// A regra de atribuição vive só aqui. Quem chama resolve cupom e UTM para criadores
// e passa o resultado; esta função decide quem leva a venda.
//
// Desempate quando cupom e UTM apontam para criadores diferentes: o CUPOM vence.
// Motivo: o cupom foi digitado e resgatado na compra (intenção explícita, e o desconto
// já foi concedido em nome daquele criador); o UTM é só o último clique e pode ter sido
// sobrescrito por outro link. O criador do UTM fica registrado em `conflict_creator_id`
// para auditoria, mas não leva a venda.

export type AttributionSource = "coupon" | "utm" | "coupon+utm";

export type AttributionInput = {
  // Criadores dos cupons do pedido, na ordem em que aparecem (null = cupom sem dono).
  couponCreatorIds: Array<string | null>;
  utmCreatorId: string | null;
};

export type Attribution = {
  creator_id: string | null;
  source: AttributionSource | null;
  conflict_creator_id: string | null;
};

export function attribute(input: AttributionInput): Attribution {
  // Com mais de um cupom de criadores diferentes, vale o primeiro da lista.
  const couponCreator = input.couponCreatorIds.find((id): id is string => id !== null) ?? null;
  const utmCreator = input.utmCreatorId;

  if (couponCreator && utmCreator) {
    if (couponCreator === utmCreator) {
      return { creator_id: couponCreator, source: "coupon+utm", conflict_creator_id: null };
    }
    return { creator_id: couponCreator, source: "coupon", conflict_creator_id: utmCreator };
  }
  if (couponCreator) return { creator_id: couponCreator, source: "coupon", conflict_creator_id: null };
  if (utmCreator) return { creator_id: utmCreator, source: "utm", conflict_creator_id: null };
  return { creator_id: null, source: null, conflict_creator_id: null };
}
