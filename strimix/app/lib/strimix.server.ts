import { createHash, randomBytes } from "node:crypto";
import db from "../db.server";
import { getOrCreateShopSettings, getServerApiKey } from "./settings.server";

const NON_RETRYABLE_CODES = new Set([400, 401, 403, 404, 422]);
const RETRY_DELAYS_MS = [60_000, 120_000, 240_000];

type StrimixAttribute = { name?: string | null; value?: string | null };
type StrimixLineItem = {
  variant_id?: string | number | null;
  product_id?: string | number | null;
  name?: string | null;
  quantity?: number | string | null;
  price?: number | string | null;
  price_set?: { shop_money?: { amount?: number | string | null } | null } | null;
  subtotal?: number | string | null;
  /** Line item properties (e.g. _strimix_avid for Buy Now). */
  customAttributes?: Array<{ key?: string | null; value?: string | null }> | null;
};
type StrimixCustomer = { id?: string | number | null; email?: string | null; phone?: string | null };
type StrimixOrder = {
  id?: string | number | null;
  currency?: string | null;
  email?: string | null;
  phone?: string | null;
  customer?: StrimixCustomer | null;
  /** When order has no strimix_avid in attributes, fallback from customer metafield (logged-in buyers). */
  customerStrimixAvid?: string | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  total_price?: number | string | null;
  current_total_price?: number | string | null;
  total_outstanding?: number | string | null;
  note_attributes?: StrimixAttribute[] | null;
  noteAttributes?: StrimixAttribute[] | null;
  attributes?: StrimixAttribute[] | null;
  line_items?: StrimixLineItem[] | null;
};
/** Shopify refund webhook payload: total (REST), amount, transactions, refund_line_items. */
type StrimixRefund = {
  total?: number | string | null;
  amount?: number | string | null;
  transactions?: Array<{ amount?: number | string | null }> | null;
  refund_line_items?: StrimixLineItem[] | null;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(email?: string | null) {
  if (!email) return undefined;
  return email.trim().toLowerCase();
}

function normalizePhone(phone?: string | null) {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, "");
  return digits || undefined;
}

function toNumber(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

const STRIMIX_AVID_KEY = "strimix_avid";
/** Line item property key for Buy Now flow (persists to order line item customAttributes). */
const STRIMIX_AVID_LINE_ITEM_KEY = "_strimix_avid";

/** Reads strimix_avid from order: order-level customAttributes first, then first line item's customAttributes (_strimix_avid for Buy Now). */
function getAvidFromOrder(order: StrimixOrder) {
  const o = order as StrimixOrder & {
    custom_attributes?: Array<{ name?: string; value?: string }>;
    customAttributes?: Array<{ key?: string; value?: string }>;
  };
  const attributes: StrimixAttribute[] = [
    ...(order.note_attributes ?? []),
    ...(order.noteAttributes ?? []),
    ...(order.attributes ?? []),
    ...(o.custom_attributes ?? []).map((a) => ({ name: a.name, value: a.value })),
    ...(o.customAttributes ?? []).map((a) => ({ name: a.key, value: a.value })),
  ];
  let item = attributes.find(
    (attr) => (attr?.name ?? "").toLowerCase() === STRIMIX_AVID_KEY.toLowerCase(),
  );
  let value = typeof item?.value === "string" ? item.value : undefined;
  if (!value && order.line_items && order.line_items.length > 0) {
    const firstLine = order.line_items[0] as StrimixLineItem & { customAttributes?: Array<{ key?: string; value?: string }> };
    const lineAttrs = firstLine?.customAttributes ?? [];
    const avidAttr = lineAttrs.find(
      (a) => (a?.key ?? "").toLowerCase() === STRIMIX_AVID_LINE_ITEM_KEY.toLowerCase(),
    );
    value = typeof avidAttr?.value === "string" ? avidAttr.value : undefined;
  }
  return value;
}

function mapProducts(lineItems: StrimixLineItem[] = [], currency: string) {
  return lineItems.map((item) => ({
    id: String(item?.variant_id ?? item?.product_id ?? ""),
    name: String(item?.name ?? ""),
    quantity: Number(item?.quantity ?? 0),
    value: toNumber(item?.price ?? item?.price_set?.shop_money?.amount),
    currency,
  }));
}

function getUserExternalIds(customer: StrimixCustomer | null | undefined, email?: string, phone?: string) {
  return {
    hashed_email: email ? sha256(email) : undefined,
    hashed_phone: phone ? sha256(phone) : undefined,
    shopify_customer_id: customer?.id ? String(customer.id) : undefined,
  };
}

function shouldRetry(statusCode?: number) {
  if (!statusCode) return true;
  if (NON_RETRYABLE_CODES.has(statusCode)) return false;
  return statusCode >= 400;
}

async function sendToStrimix(shop: string, payload: unknown, streamId: string) {
  const apiKey = await getServerApiKey(shop);
  if (!apiKey) {
    throw new Error("Server API key is not configured");
  }

  const url = new URL("https://api.strimix.io/collect");
  url.searchParams.set("stream_id", streamId);
  url.searchParams.set("api_key", apiKey);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    const error = new Error(
      `Strimix collect failed with status ${response.status}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`,
    ) as Error & {
      statusCode?: number;
    };
    error.statusCode = response.status;
    throw error;
  }
}

/** Send begin_checkout event from Web Pixel to Strimix. */
export async function sendPixelBeginCheckout(
  shop: string,
  payload: {
    strimix_avid: string | null;
    email?: string | null;
    phone?: string | null;
    products?: Array<{ id: string; name: string; quantity: number; value: number; currency?: string }>;
  },
): Promise<void> {
  const streamId = await getShopStreamId(shop);
  if (!streamId || !String(streamId).trim()) {
    return;
  }

  const email = normalizeEmail(payload.email ?? null);
  const phone = normalizePhone(payload.phone ?? null);
  const body = {
    event_name: "begin_checkout",
    strimix_avid: payload.strimix_avid ?? null,
    user_external_ids: getUserExternalIds(null, email ?? undefined, phone ?? undefined),
    products: payload.products ?? [],
  };

  await sendToStrimix(shop, body, streamId);
}

export async function enqueueOutboundEvent(input: {
  shop: string;
  eventName: string;
  streamId: string;
  payload: unknown;
  webhookEventId?: string;
}) {
  await db.outboundEventDelivery.create({
    data: {
      shop: input.shop,
      eventName: input.eventName,
      streamId: input.streamId,
      payloadJson: JSON.stringify(input.payload),
      webhookEventId: input.webhookEventId ?? null,
      status: "pending",
    },
  });
}

export async function processDueOutboundEvents(shop: string, limit = 20) {
  const now = new Date();
  const events = await db.outboundEventDelivery.findMany({
    where: {
      shop,
      status: "pending",
      nextAttemptAt: { lte: now },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let lastStatus: string | null = null;
  let lastErrorMessage: string | null = null;

  for (const item of events) {
    let status = "sent";
    let errorCode: number | null = null;
    let errorMessage: string | null = null;
    let nextAttemptAt: Date | null = null;
    let sentAt: Date | null = new Date();
    let attemptCount = item.attemptCount;

    try {
      const payload = JSON.parse(item.payloadJson);
      await sendToStrimix(item.shop, payload, item.streamId);
    } catch (error) {
      const err = error as { statusCode?: number; message?: string };
      const code = Number(err?.statusCode) || null;
      const retryable = shouldRetry(code ?? undefined);
      const canRetry = retryable && item.attemptCount < RETRY_DELAYS_MS.length;

      status = canRetry ? "pending" : "failed";
      errorCode = code;
      errorMessage = err?.message ?? "Unknown Strimix error";
      sentAt = null;

      if (canRetry) {
        attemptCount = item.attemptCount + 1;
        nextAttemptAt = new Date(Date.now() + RETRY_DELAYS_MS[item.attemptCount]!);
      }
    }

    lastStatus = status;
    lastErrorMessage = status === "failed" ? errorMessage : null;

    await db.outboundEventDelivery.update({
      where: { id: item.id },
      data: {
        status,
        attemptCount,
        nextAttemptAt: nextAttemptAt ?? item.nextAttemptAt,
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
        sentAt,
      },
    });
  }

  if (events.length > 0 && lastStatus !== null) {
    await db.shopSettings.updateMany({
      where: { shop },
      data: {
        lastServerSendAt: new Date(),
        lastServerSendStatus: lastStatus,
        lastErrorMessage: lastErrorMessage,
      },
    });
  }
}

/** Returns distinct shop domains that have pending outbound events due for delivery. */
export async function getShopsWithDueOutboundEvents(): Promise<string[]> {
  const now = new Date();
  const rows = await db.outboundEventDelivery.groupBy({
    by: ["shop"],
    where: {
      status: "pending",
      nextAttemptAt: { lte: now },
    },
  });
  return rows.map((r) => r.shop);
}

export async function markWebhookReceived(input: {
  shop: string;
  eventId: string;
  topic: string;
  resourceId?: string;
}) {
  try {
    await db.webhookDelivery.create({
      data: {
        shop: input.shop,
        eventId: input.eventId,
        topic: input.topic,
        resourceId: input.resourceId ?? null,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Save order_id + strimix_avid from Web Pixel (checkout_completed) for linking with webhook. */
export async function savePixelOrderAvid(
  shop: string,
  orderId: string,
  strimixAvid: string,
  avidSource?: string | null,
): Promise<void> {
  await (db as unknown as {
    pixelOrderAvid: {
      upsert: (args: {
        where: { shop_orderId: { shop: string; orderId: string } };
        create: { shop: string; orderId: string; strimixAvid: string; avidSource?: string | null };
        update: { strimixAvid: string; avidSource?: string | null };
      }) => Promise<unknown>;
    };
  }).pixelOrderAvid.upsert({
    where: {
      shop_orderId: { shop, orderId: String(orderId) },
    },
    create: { shop, orderId: String(orderId), strimixAvid, avidSource: avidSource ?? null },
    update: { strimixAvid, avidSource: avidSource ?? null },
  });
}

/** Get strimix_avid stored by Web Pixel for this order (fallback when order/customer have none). */
export async function getPixelOrderAvid(
  shop: string,
  orderId: string | number,
): Promise<string | null> {
  const row = await (db as unknown as { pixelOrderAvid: { findUnique: (args: { where: { shop_orderId: { shop: string; orderId: string } } }) => Promise<{ strimixAvid: string; avidSource?: string | null } | null> } }).pixelOrderAvid.findUnique({
    where: { shop_orderId: { shop, orderId: String(orderId) } },
  });
  return row?.strimixAvid ?? null;
}

export async function getPixelOrderAvidWithSource(
  shop: string,
  orderId: string | number,
): Promise<{ strimixAvid: string; avidSource: string | null } | null> {
  const row = await (db as unknown as {
    pixelOrderAvid: {
      findUnique: (args: {
        where: { shop_orderId: { shop: string; orderId: string } };
      }) => Promise<{ strimixAvid: string; avidSource?: string | null } | null>;
    };
  }).pixelOrderAvid.findUnique({
    where: { shop_orderId: { shop, orderId: String(orderId) } },
  });
  if (!row) return null;
  return { strimixAvid: row.strimixAvid, avidSource: row.avidSource ?? null };
}

export async function buildOrderEventPayload(
  eventName: "new_order" | "update_order",
  order: StrimixOrder,
  options?: { pixelStrimixAvid?: string | null; pixelAvidSource?: string | null },
): Promise<{
  event_name: string;
  strimix_avid: string | null;
  user_external_ids: ReturnType<typeof getUserExternalIds>;
  order: { id: string; status: string; value: number; paid_value: number; currency: string };
  products: ReturnType<typeof mapProducts>;
}> {
  let avidSource: "cookie" | "inline_item" | "attribute" | "metafield" | "pixel_order" | "none" = "none";
  let strimixAvid: string | null = null;

  if (options?.pixelStrimixAvid) {
    strimixAvid = options.pixelStrimixAvid;
    if (options.pixelAvidSource === "cookie") avidSource = "cookie";
    else if (options.pixelAvidSource === "inline_item") avidSource = "inline_item";
    else avidSource = "pixel_order";
  } else {
    const orderAvid = getAvidFromOrder(order);
    if (orderAvid) {
      const firstLine = order.line_items?.[0] ?? null;
      const lineAttrs = (firstLine?.customAttributes ?? []) as Array<{ key?: string | null; value?: string | null }>;
      const hasInlineAvid =
        lineAttrs.some(
          (a) =>
            (a?.key ?? "").toLowerCase() === STRIMIX_AVID_LINE_ITEM_KEY.toLowerCase() &&
            typeof a?.value === "string" &&
            a.value.trim().length > 0,
        );
      avidSource = hasInlineAvid ? "inline_item" : "attribute";
      strimixAvid = orderAvid;
    } else if (order.customerStrimixAvid) {
      avidSource = "metafield";
      strimixAvid = order.customerStrimixAvid;
    }
  }

  const currency = String(order.currency || "");
  const email = normalizeEmail(order?.email ?? order?.customer?.email);
  const phone = normalizePhone(order?.phone ?? order?.customer?.phone);
  const paidValue =
    toNumber(order.current_total_price ?? order.total_price) - toNumber(order.total_outstanding ?? 0);

  return {
    event_name: eventName,
    strimix_avid: strimixAvid ?? null,
    user_external_ids: getUserExternalIds(order.customer, email, phone),
    order: {
      id: String(order.id),
      status: String(order.financial_status ?? order.fulfillment_status ?? ""),
      value: toNumber(order.current_total_price ?? order.total_price),
      paid_value: paidValue > 0 ? paidValue : toNumber(order.current_total_price ?? order.total_price),
      currency,
    },
    products: mapProducts(order.line_items ?? [], currency),
  };
}

export async function buildRefundEventPayload(refund: StrimixRefund, order: StrimixOrder) {
  const currency = String(order?.currency || "");
  const email = normalizeEmail(order?.email ?? order?.customer?.email);
  const phone = normalizePhone(order?.phone ?? order?.customer?.phone);
  const refundValue =
    toNumber(refund?.total) ||
    toNumber(refund?.amount) ||
    toNumber(refund?.transactions?.[0]?.amount) ||
    toNumber(
      refund?.refund_line_items?.reduce(
        (sum, item) => sum + toNumber(item?.subtotal),
        0,
      ),
    );

  const strimixAvid = getAvidFromOrder(order) ?? order.customerStrimixAvid ?? null;
  return {
    event_name: "refund",
    strimix_avid: strimixAvid ?? null,
    user_external_ids: getUserExternalIds(order?.customer, email, phone),
    order: {
      id: String(order?.id ?? ""),
      status: String(order?.financial_status ?? ""),
      value: toNumber(order?.current_total_price ?? order?.total_price),
      paid_value:
        toNumber(order?.current_total_price ?? order?.total_price) -
        toNumber(order?.total_outstanding ?? 0),
      refund_value: refundValue,
      currency,
    },
    products: mapProducts(order?.line_items ?? [], currency),
  };
}

export async function getShopStreamId(shop: string) {
  const settings = await getOrCreateShopSettings(shop);
  return settings.streamId;
}

/** Set strimix_avid on customer metafield (for logged-in buyers; used as fallback when order has no strimix_avid). */
export async function setCustomerStrimixAvid(
  shop: string,
  customerId: string | number,
  strimixAvid: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await db.session.findFirst({
      where: { shop, isOnline: false },
      orderBy: { expires: "desc" },
    });
    if (!session?.accessToken) {
      return { success: false, error: "No offline session for shop" };
    }
    const customerGid =
      typeof customerId === "number" || /^\d+$/.test(String(customerId))
        ? `gid://shopify/Customer/${customerId}`
        : customerId;
    const apiVersion = "2024-10";
    const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
    const mutation = `#graphql
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id value }
          userErrors { field message }
        }
      }`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          metafields: [
            {
              ownerId: customerGid,
              namespace: STRIMIX_METAFIELD_NAMESPACE,
              key: STRIMIX_METAFIELD_KEY_AVID,
              value: strimixAvid,
              type: "single_line_text_field",
            },
          ],
        },
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      return { success: false, error: `Shopify API ${response.status}: ${text.slice(0, 150)}` };
    }
    const json = (await response.json()) as {
      data?: { metafieldsSet?: { userErrors?: Array<{ message?: string }> } };
      errors?: Array<{ message?: string }>;
    };
    const userErrors = json.data?.metafieldsSet?.userErrors ?? [];
    const apiErrors = json.errors ?? [];
    if (userErrors.length > 0 || apiErrors.length > 0) {
      const msg = userErrors[0]?.message ?? apiErrors[0]?.message ?? "Unknown error";
      return { success: false, error: msg };
    }
    return { success: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { success: false, error: message };
  }
}

type AdminGraphqlClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

const STRIMIX_METAFIELD_NAMESPACE = "strimix";
const STRIMIX_METAFIELD_KEY_AVID = "avid";

type GraphqlOrderNode = {
  legacyResourceId?: string | number;
  currentTotalPriceSet?: { shopMoney?: { amount?: string | number; currencyCode?: string } };
  totalOutstandingSet?: { shopMoney?: { amount?: string | number; currencyCode?: string } };
  displayFinancialStatus?: string;
  email?: string | null;
  phone?: string | null;
  customer?: {
    legacyResourceId?: string | number;
    id?: string;
    email?: string | null;
    phone?: string | null;
    metafield?: { value?: string | null } | null;
  } | null;
  customAttributes?: Array<{ key?: string | null; value?: string | null }> | null;
  lineItems?: {
    nodes?: Array<{
      name?: string;
      quantity?: number;
      originalUnitPriceSet?: { shopMoney?: { amount?: string | number } };
      variant?: { legacyResourceId?: string | number };
      product?: { legacyResourceId?: string | number };
      customAttributes?: Array<{ key?: string | null; value?: string | null }> | null;
    }> | null;
  } | null;
};

function firstGraphqlErrorMessage(json: unknown): string | null {
  const err = json as { errors?: Array<{ message?: string }> };
  const first = err.errors?.[0]?.message;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

/** Create or update Web Pixel with streamId, privacyMode, storeHostname. Saves webPixelId to ShopSettings when created. */
export async function ensureStrimixWebPixel(
  admin: AdminGraphqlClient,
  shop: string,
  options: { streamId: string; privacyMode: string; beginCheckoutEnabled?: boolean },
): Promise<{ success: boolean; error?: string }> {
  try {
    const settingsRow = await db.shopSettings.findUnique({ where: { shop } });
    const webPixelId = (settingsRow as { webPixelId?: string | null } | null)?.webPixelId ?? null;
    const existingPixelToken = (settingsRow as { pixelToken?: string | null } | null)?.pixelToken ?? null;
    const pixelToken = existingPixelToken ?? randomBytes(24).toString("hex");
    if (!existingPixelToken) {
      await (db as unknown as { shopSettings: { update: (args: { where: { shop: string }; data: { pixelToken: string } }) => Promise<unknown> } }).shopSettings.update({
        where: { shop },
        data: { pixelToken },
      });
    }

    const rawAppUrl = String(process.env.SHOPIFY_APP_URL ?? "").trim();
    let appBaseUrl = rawAppUrl.replace(/\/+$/, "");
    try {
      if (rawAppUrl) appBaseUrl = new URL(rawAppUrl).origin;
    } catch {
      /* keep trimmed URL; pixel normalizes with new URL().origin */
    }
    const cookieName =
      String((settingsRow as { cookieName?: string | null } | null)?.cookieName ?? "").trim() || "sx_uid";
    const pixelSettings = {
      streamId: String(options.streamId ?? "").trim(),
      privacyMode: String(options.privacyMode ?? "strict").trim(),
      /** Web pixel settings are string fields; keep in sync with clientEventBeginCheckout */
      beginCheckoutEnabled: options.beginCheckoutEnabled === false ? "false" : "true",
      storeHostname: shop,
      appBaseUrl,
      pixelToken,
      cookieName,
    };

    if (webPixelId) {
      const response = await admin.graphql(
        `#graphql
        mutation webPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
          webPixelUpdate(id: $id, webPixel: $webPixel) {
            userErrors { field message code }
            webPixel { id settings }
          }
        }`,
        {
          variables: {
            id: webPixelId,
            webPixel: { settings: JSON.stringify(pixelSettings) },
          },
        },
      );
      const json = (await response.json()) as {
        data?: { webPixelUpdate?: { userErrors?: Array<{ message?: string }>; webPixel?: { id: string } } };
        errors?: Array<{ message?: string }>;
      };
      const gqlMsg = firstGraphqlErrorMessage(json);
      if (gqlMsg) return { success: false, error: gqlMsg };
      const errors = json.data?.webPixelUpdate?.userErrors ?? [];
      if (errors.length > 0) {
        return { success: false, error: errors[0]?.message ?? "webPixelUpdate failed" };
      }
      return { success: true };
    }

    const response = await admin.graphql(
      `#graphql
      mutation webPixelCreate($webPixel: WebPixelInput!) {
        webPixelCreate(webPixel: $webPixel) {
          userErrors { field message code }
          webPixel { id settings }
        }
      }`,
      {
        variables: {
          webPixel: { settings: JSON.stringify(pixelSettings) },
        },
      },
    );
    const json = (await response.json()) as {
      data?: { webPixelCreate?: { userErrors?: Array<{ message?: string }>; webPixel?: { id: string } } };
      errors?: Array<{ message?: string }>;
    };
    const gqlMsgCreate = firstGraphqlErrorMessage(json);
    if (gqlMsgCreate) return { success: false, error: gqlMsgCreate };
    const errors = json.data?.webPixelCreate?.userErrors ?? [];
    if (errors.length > 0) {
      return { success: false, error: errors[0]?.message ?? "webPixelCreate failed" };
    }
    const newId = json.data?.webPixelCreate?.webPixel?.id;
    if (newId) {
      await (db as unknown as { shopSettings: { update: (args: { where: { shop: string }; data: { webPixelId: string } }) => Promise<unknown> } }).shopSettings.update({
        where: { shop },
        data: { webPixelId: newId },
      });
    }
    return { success: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { success: false, error: message };
  }
}

/** Fetches full order from Admin API (including note_attributes for strimix_avid). */
export async function fetchOrderByAdminGraphql(
  admin: AdminGraphqlClient,
  orderId: number,
): Promise<StrimixOrder | null> {
  const gqlId = `gid://shopify/Order/${orderId}`;
  const response = await admin.graphql(
    `#graphql
    query StrimixOrder($id: ID!) {
      order(id: $id) {
        legacyResourceId
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        totalOutstandingSet { shopMoney { amount currencyCode } }
        displayFinancialStatus
        email
        phone
        customAttributes { key value }
        customer {
          id
          legacyResourceId
          metafield(namespace: "${STRIMIX_METAFIELD_NAMESPACE}", key: "${STRIMIX_METAFIELD_KEY_AVID}") {
            value
          }
        }
        lineItems(first: 250) {
          nodes {
            name
            quantity
            originalUnitPriceSet { shopMoney { amount } }
            variant { legacyResourceId }
            product { legacyResourceId }
            customAttributes { key value }
          }
        }
      }
    }`,
    { variables: { id: gqlId } },
  );

  const json = (await response.json()) as { data?: { order?: GraphqlOrderNode } };
  const order = json?.data?.order;
  if (!order) {
    return null;
  }

  const customerStrimixAvid =
    order.customer?.metafield?.value && typeof order.customer.metafield.value === "string"
      ? order.customer.metafield.value
      : undefined;
  return {
    id: Number(order.legacyResourceId),
    currency:
      order.currentTotalPriceSet?.shopMoney?.currencyCode ??
      order.totalOutstandingSet?.shopMoney?.currencyCode ??
      "",
    current_total_price: Number(order.currentTotalPriceSet?.shopMoney?.amount ?? 0),
    total_outstanding: Number(order.totalOutstandingSet?.shopMoney?.amount ?? 0),
    financial_status: String(order.displayFinancialStatus ?? ""),
    fulfillment_status: order.displayFinancialStatus ?? "",
    email: order.email ?? null,
    phone: order.phone ?? null,
    customer: order.customer
      ? {
          id: order.customer.legacyResourceId ?? order.customer.id,
          email: order.customer.email ?? null,
          phone: order.customer.phone ?? null,
        }
      : null,
    note_attributes: (order.customAttributes ?? []).map((a) => ({ name: a.key ?? "", value: a.value ?? "" })),
    customerStrimixAvid,
    line_items: (order.lineItems?.nodes ?? []).map((node) => ({
      name: node.name,
      quantity: node.quantity ?? 0,
      price: Number(node.originalUnitPriceSet?.shopMoney?.amount ?? 0),
      variant_id: node.variant?.legacyResourceId ?? node.product?.legacyResourceId,
      product_id: node.product?.legacyResourceId,
      customAttributes: node.customAttributes ?? undefined,
    })),
  };
}
