/** Shopify offline session id format used by @shopify/shopify-api session storage. */
export function offlineSessionId(shop: string): string {
  return `offline_${shop}`;
}
