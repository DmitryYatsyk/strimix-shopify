import { register } from "@shopify/web-pixels-extension";

function avidFromAttributeList(list) {
  if (!Array.isArray(list)) return null;
  for (const a of list) {
    const key = String(a?.key ?? a?.name ?? "").trim();
    const value = String(a?.value ?? "").trim();
    if (!key || !value) continue;
    const k = key.toLowerCase();
    if (k === "_strimix_avid" || k === "strimix_avid") return value;
  }
  return null;
}

/**
 * Primary avid on same-domain / custom checkout: browser.cookie (sx_uid), set by storefront embed with
 * Domain=.yourroot.com so checkout subdomain can read it. Fallback: cart attributes / line properties
 * (Buy now) — we mirror those into the cookie when possible so later events use cookie.
 * On checkout.shopify.com (different site), cookie is usually empty; fallbacks matter there.
 */
function avidFromAttributesRaw(attributes) {
  if (attributes == null) return null;
  if (Array.isArray(attributes)) return avidFromAttributeList(attributes);
  if (typeof attributes === "object") {
    for (const [key, value] of Object.entries(attributes)) {
      const found = avidFromAttributeList([{ key, value }]);
      if (found) return found;
    }
  }
  return null;
}

function normalizeLineItems(lineItems) {
  if (!lineItems) return [];
  if (Array.isArray(lineItems)) return lineItems;
  if (Array.isArray(lineItems.edges)) {
    return lineItems.edges.map((e) => e?.node).filter(Boolean);
  }
  return [];
}

/** Cart/checkout attributes + line item properties / merchandise attributes. */
function avidFromCheckout(checkout) {
  const fromCart =
    avidFromAttributesRaw(checkout?.attributes) ||
    avidFromAttributesRaw(checkout?.noteAttributes) ||
    avidFromAttributesRaw(checkout?.customAttributes);
  if (fromCart) return fromCart;

  const lineItems = normalizeLineItems(checkout?.lineItems);
  for (const item of lineItems) {
    const attrs =
      item?.customAttributes ??
      item?.properties ??
      item?.attributes ??
      item?.merchandise?.customAttributes ??
      item?.variant?.customAttributes ??
      [];
    const found = Array.isArray(attrs) || typeof attrs === "object" ? avidFromAttributesRaw(attrs) : null;
    if (found) return found;
  }
  return null;
}

function getProductsFromCheckout(checkout) {
  const lineItems = normalizeLineItems(checkout?.lineItems);
  const currency = checkout?.totalPrice?.currencyCode ?? "USD";
  return lineItems.map((item) => {
    const lineMoney = item?.finalLinePrice ?? item?.price;
    const amount = Number(lineMoney?.amount ?? 0);
    return {
      id: String(
        item?.variant?.id ?? item?.variant?.product?.id ?? item?.product?.id ?? item?.merchandise?.id ?? "",
      ),
      name: String(item?.title ?? ""),
      quantity: Number(item?.quantity ?? 1),
      value: amount,
      currency,
    };
  });
}

/**
 * Public handler is GET/POST /pixel-events on the app host (token auth).
 * Never use .../apps/strimix/pixel-events from the browser — that hits App Proxy routes.
 */
function pixelEventsEndpoint(appBaseUrlRaw) {
  const trimmed = String(appBaseUrlRaw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    return `${new URL(trimmed).origin}/pixel-events`;
  } catch {
    return `${trimmed}/pixel-events`;
  }
}

function orderIdFromGid(id) {
  if (id == null) return null;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return trimmed;
  // gid format: gid://shopify/Order/123456789
  let match = trimmed.match(/\/Order\/(\d+)/i);
  if (match) return match[1];
  // fallback: any Order/123 digits in string
  match = trimmed.match(/Order[:/](\d+)/i);
  if (match) return match[1];
  return null;
}

register(async ({ analytics, browser, settings, init, customerPrivacy }) => {
  const privacyMode = (settings?.privacyMode ?? "strict").toLowerCase();
  const beginCheckoutEnabled =
    String(settings?.beginCheckoutEnabled ?? "true").trim().toLowerCase() !== "false";
  const streamId = settings?.streamId?.trim();
  const storeHostname = settings?.storeHostname?.trim();
  const appBaseUrl = settings?.appBaseUrl?.trim();
  const pixelToken = settings?.pixelToken?.trim();
  /** Must match storefront embed cookie (ShopSettings.cookieName), default sx_uid */
  const cookieName = String(settings?.cookieName ?? "sx_uid").trim() || "sx_uid";
  if (!streamId || !storeHostname || !appBaseUrl || !pixelToken) return;

  const endpoint = pixelEventsEndpoint(appBaseUrl);
  let consentState = init?.customerPrivacy ?? null;
  /** Last checkout_* event payload so we can send begin_checkout after consent updates (strict). */
  let lastCheckoutEventForBegin = null;

  /** Block only on explicit analytics denial; undefined / true allows (Shopify often reports false before a choice). */
  const canTrackByPrivacy = () => {
    if (privacyMode === "disabled") return true;
    if (consentState?.analyticsProcessingAllowed === false) return false;
    return true;
  };

  const sendEvent = async (body, opts = {}) => {
    try {
      if (!endpoint) return;
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        mode: "cors",
        keepalive: Boolean(opts.keepalive),
      });
    } catch {
      // Ignore network errors from sandboxed pixel runtime.
    }
  };

  /** Same-domain checkout: embed sets scoped cookie (see storefront cookieDomainAttr). */
  const getAvidFromCookie = async () => {
    try {
      const value = await browser.cookie.get(cookieName);
      return value && typeof value === "string" ? value.trim() : null;
    } catch {
      return null;
    }
  };

  /** If avid came only from cart/line (e.g. Buy now), persist to cookie on this host for cookie-first flows */
  const mirrorAvidToCookieIfNeeded = async (avid, hadCookie) => {
    if (!avid || hadCookie || !browser?.cookie?.set) return;
    try {
      await browser.cookie.set(cookieName, avid);
    } catch {
      // ignore
    }
  };

  const dedupeKey = (checkout) => {
    const id = checkout?.id ?? checkout?.token ?? null;
    return id ? `sx_bc_${String(id)}` : null;
  };


  const setOnce = async (key) => {
    try {
      if (key) await browser.localStorage.set(key, "1");
    } catch {
      // ignore
    }
  };

  const sendBeginCheckout = async (event) => {
    const checkout = event?.data?.checkout;
    const onceKey = dedupeKey(checkout);
  

    const cookieAvid = await getAvidFromCookie();
    const inlineAvid = avidFromCheckout(checkout);
    const strimix_avid = cookieAvid ?? inlineAvid;
    const avid_source = cookieAvid ? "cookie" : inlineAvid ? "checkout_attribute" : "none";
    await mirrorAvidToCookieIfNeeded(strimix_avid, Boolean(cookieAvid));
    const products = getProductsFromCheckout(checkout);
    await sendEvent(
      {
        event_name: "begin_checkout",
        shop: storeHostname,
        pixel_token: pixelToken,
        strimix_avid,
        avid_source,
        email: checkout?.email ?? null,
        phone: checkout?.phone ?? null,
        products,
      },
      { keepalive: false },
    );
    await setOnce(onceKey);
  };

  const onCheckoutForBegin = async (event) => {
    lastCheckoutEventForBegin = event;
    await sendBeginCheckout(event);
  };

  if (customerPrivacy?.subscribe) {
    customerPrivacy.subscribe("visitorConsentCollected", async (event) => {
      consentState = event?.customerPrivacy ?? consentState;
      if (lastCheckoutEventForBegin && beginCheckoutEnabled && canTrackByPrivacy()) {
        await sendBeginCheckout(lastCheckoutEventForBegin);
      }
    });
  }

  // Fires when buyer lands on checkout (covers "Buy now" better)
  analytics.subscribe("checkout_viewed", onCheckoutForBegin);
  // Keep this too (some flows fire started but not viewed)
  analytics.subscribe("checkout_started", onCheckoutForBegin);

  analytics.subscribe("checkout_completed", async (event) => {
    if (!canTrackByPrivacy()) return;
    const checkout = event?.data?.checkout;
    const cookieAvid = await getAvidFromCookie();
    const inlineAvid = avidFromCheckout(checkout);
    const strimix_avid = cookieAvid ?? inlineAvid;
    const avid_source = cookieAvid ? "cookie" : inlineAvid ? "checkout_attribute" : "none";
    await mirrorAvidToCookieIfNeeded(strimix_avid, Boolean(cookieAvid));
    const order = checkout?.order;
    const rawId = order?.id ?? order?.legacyResourceId ?? order?.legacy_resource_id ?? null;
    const orderId = orderIdFromGid(rawId);
    if (!orderId) return;
    await sendEvent(
      {
        event_name: "purchase",
        shop: storeHostname,
        pixel_token: pixelToken,
        strimix_avid,
        avid_source,
        order_id: orderId,
      },
      { keepalive: true },
    );
  });
});
