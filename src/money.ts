// Dinheiro sempre em centavos inteiros. O webhook manda string decimal ("199.90"), como a Shopify.
export function parseMoneyToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const reais = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  return reais * 100 + cents;
}

export function formatCents(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
