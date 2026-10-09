import { createHmac, timingSafeEqual } from "node:crypto";

// Mesma assinatura da Shopify: base64(HMAC-SHA256(corpo cru, segredo)) no cabeçalho X-Shopify-Hmac-Sha256.
export function isValidSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(header, "base64");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function sign(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}
