import db from "../db.server";

export type PrivacyMode = "strict" | "balanced" | "disabled";

/** Cookie name for Strimix user id; always sx_uid. Tracking permission is governed by Shopify API. */
const COOKIE_NAME = "sx_uid";

export async function getOrCreateShopSettings(shop: string) {
  let settings = await db.shopSettings.findUnique({ where: { shop } });
  if (!settings) {
    settings = await db.shopSettings.create({
      data: {
        shop,
        enabled: true,
        cookieName: "sx_uid",
        privacyMode: "strict",
      },
    });
  }
  return settings;
}

export async function upsertShopSettings(input: {
  shop: string;
  enabled: boolean;
  streamId: string;
  serverApiKey?: string;
  privacyMode: PrivacyMode;
  clientEventViewProduct: boolean;
  clientEventAddToCart: boolean;
  clientEventRemoveFromCart: boolean;
  clientEventBeginCheckout: boolean;
  serverEventNewOrder: boolean;
  serverEventUpdateOrder: boolean;
  serverEventRefund: boolean;
}) {
  const existing = await getOrCreateShopSettings(input.shop);
  const serverApiKey = input.serverApiKey
    ? input.serverApiKey
    : existing.serverApiKey;

  return db.shopSettings.update({
    where: { shop: input.shop },
    data: {
      enabled: input.enabled,
      streamId: input.streamId || null,
      serverApiKey,
      cookieName: COOKIE_NAME,
      privacyMode: input.privacyMode,
      clientEventViewProduct: input.clientEventViewProduct,
      clientEventAddToCart: input.clientEventAddToCart,
      clientEventRemoveFromCart: input.clientEventRemoveFromCart,
      clientEventBeginCheckout: input.clientEventBeginCheckout,
      serverEventNewOrder: input.serverEventNewOrder,
      serverEventUpdateOrder: input.serverEventUpdateOrder,
      serverEventRefund: input.serverEventRefund,
    },
  });
}

/**
 * Returns settings for the public tracker script (embed.js). Only reads existing
 * shop settings; does not create records. Cookie is always sx_uid; tracking
 * permission is governed by Shopify API.
 */
export async function getSettingsForPublicTracker(shop: string) {
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  if (!settings) {
    return {
      enabled: false,
      streamId: "",
      cookieName: COOKIE_NAME,
      privacyMode: "strict" as PrivacyMode,
      jsSdkUrl: "https://cdn.strimix.io/strimix-1.1.0.js",
      loggerUrl: "https://api.strimix.io/collect/log",
      events: {
        page_view: true,
        view_product: false,
        add_to_cart: false,
        remove_from_cart: false,
      },
    };
  }
  return {
    enabled: settings.enabled,
    streamId: settings.streamId ?? "",
    cookieName: COOKIE_NAME,
    privacyMode: settings.privacyMode as PrivacyMode,
    jsSdkUrl: "https://cdn.strimix.io/strimix-1.1.0.js",
    loggerUrl: "https://api.strimix.io/collect/log",
    events: {
      page_view: true,
      view_product: settings.clientEventViewProduct,
      add_to_cart: settings.clientEventAddToCart,
      remove_from_cart: settings.clientEventRemoveFromCart,
    },
  };
}

export async function getServerApiKey(shop: string) {
  const settings = await getOrCreateShopSettings(shop);
  return settings.serverApiKey ?? null;
}
