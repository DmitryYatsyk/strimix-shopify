import db from "../db.server";

/**
 * Some TS/IDE setups resolve `PrismaClient` without newer delegates after `prisma generate`.
 * Use a narrow delegate interface + `unknown` cast for CustomerDataRequest only.
 */
export type CustomerDataRequestListItem = {
  id: string;
  shopifyCustomerId: string;
  shopifyDataRequestId: string | null;
  createdAt: Date;
};

export type NewCustomerDataRequestRow = {
  shop: string;
  shopifyCustomerId: string;
  shopifyDataRequestId?: string | null;
  ordersRequestedJson: string;
  exportJson: string;
  webhookEventId: string;
};

type CustomerDataRequestDelegate = {
  create: (args: { data: NewCustomerDataRequestRow }) => Promise<{ id: string }>;
  findMany: (args: {
    where: { shop: string };
    orderBy: { createdAt: "desc" };
    take: number;
    select: {
      id: true;
      shopifyCustomerId: true;
      shopifyDataRequestId: true;
      createdAt: true;
    };
  }) => Promise<CustomerDataRequestListItem[]>;
  findUnique: (args: {
    where: { id: string };
  }) => Promise<{
    id: string;
    shop: string;
    shopifyCustomerId: string;
    exportJson: string;
  } | null>;
  deleteMany: (args: { where: { shop: string } }) => Promise<unknown>;
};

function customerDataRequestDb(): CustomerDataRequestDelegate {
  return (db as unknown as { customerDataRequest: CustomerDataRequestDelegate })
    .customerDataRequest;
}

/** Persist a customers/data_request export row (webhook → admin download). */
export async function persistCustomerDataRequest(data: NewCustomerDataRequestRow) {
  return customerDataRequestDb().create({ data });
}

/** Recent GDPR data-request rows for the settings UI (Status / Diagnostics). */
export async function listCustomerDataRequestsForShop(
  shop: string,
): Promise<CustomerDataRequestListItem[]> {
  return customerDataRequestDb().findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      id: true,
      shopifyCustomerId: true,
      shopifyDataRequestId: true,
      createdAt: true,
    },
  });
}

/** Clear all saved customers/data_request rows for this shop. */
export async function clearCustomerDataRequestsForShop(shop: string): Promise<number> {
  const result = await customerDataRequestDb().deleteMany({ where: { shop } });
  return typeof result === "object" && result != null && "count" in result
    ? Number((result as { count?: number }).count ?? 0)
    : 0;
}

/** Row for GET /app/customer-data/:id (JSON download). */
export async function getCustomerDataRequestExportById(shop: string, id: string) {
  const row = await customerDataRequestDb().findUnique({ where: { id } });
  if (!row || row.shop !== shop) return null;
  return row;
}

/**
 * Deletes all app-persisted data for a shop (GDPR shop/redact, uninstall cleanup).
 */
export async function deleteAllShopData(shop: string): Promise<void> {
  /* Sequential deletes — reliable on MongoDB without multi-doc transactions. */
  await db.session.deleteMany({ where: { shop } });
  await db.shopSettings.deleteMany({ where: { shop } });
  await db.webhookDelivery.deleteMany({ where: { shop } });
  await db.outboundEventDelivery.deleteMany({ where: { shop } });
  await db.pixelOrderAvid.deleteMany({ where: { shop } });
  await customerDataRequestDb().deleteMany({ where: { shop } });
}

type ShopifyCustomerPayload = { id?: number | string; email?: string | null; phone?: string | null };

export type CustomersDataRequestPayload = {
  shop_id?: number;
  shop_domain?: string;
  customer?: ShopifyCustomerPayload;
  orders_requested?: number[];
  data_request?: { id?: number };
};

export type CustomersRedactPayload = {
  shop_id?: number;
  shop_domain?: string;
  customer?: ShopifyCustomerPayload;
  orders_to_redact?: number[];
};

function orderIdList(ids: number[] | undefined): string[] {
  if (!ids?.length) return [];
  return ids.map((id) => String(id));
}

/**
 * Builds JSON export for customers/data_request (data stored by this app only).
 */
export async function buildCustomerDataExportJson(
  shop: string,
  payload: CustomersDataRequestPayload,
): Promise<string> {
  const customerId = payload.customer?.id;
  const customerIdStr =
    customerId != null && customerId !== "" ? String(customerId) : "";
  const ordersRequested = Array.isArray(payload.orders_requested)
    ? payload.orders_requested
    : [];
  const orderIdStrings = orderIdList(ordersRequested);

  const pixel =
    orderIdStrings.length > 0
      ? await db.pixelOrderAvid.findMany({
          where: { shop, orderId: { in: orderIdStrings } },
        })
      : [];

  const allOutbound = await db.outboundEventDelivery.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" },
  });

  const outboundForOrders = allOutbound.filter((row) => {
    try {
      const p = JSON.parse(row.payloadJson) as { order?: { id?: string } };
      const oid = p.order?.id;
      if (oid == null || !orderIdStrings.length) return false;
      return orderIdStrings.includes(String(oid));
    } catch {
      return false;
    }
  });

  const exportObj = {
    generated_at: new Date().toISOString(),
    shop,
    shopify_customer_id: customerIdStr || null,
    orders_requested: ordersRequested,
    shopify_data_request_id: payload.data_request?.id ?? null,
    note:
      "This file contains data stored by the Strimix app for this shop and the listed orders. Events sent only to Strimix Cloud (not duplicated here) are not included.",
    stored_in_app: {
      pixel_order_avids: pixel,
      outbound_event_deliveries: outboundForOrders.map((o) => ({
        id: o.id,
        eventName: o.eventName,
        source: o.source,
        status: o.status,
        createdAt: o.createdAt,
        sentAt: o.sentAt,
        payload: JSON.parse(o.payloadJson) as unknown,
      })),
    },
    raw_webhook_payload: payload,
  };

  return JSON.stringify(exportObj, null, 2);
}

/**
 * Removes customer-related rows we store for the given orders (customers/redact).
 */
export async function redactCustomerOrders(shop: string, payload: CustomersRedactPayload): Promise<void> {
  const ordersToRedact = Array.isArray(payload.orders_to_redact)
    ? payload.orders_to_redact
    : [];
  const orderIdStrings = orderIdList(ordersToRedact);
  if (orderIdStrings.length === 0) return;

  await db.pixelOrderAvid.deleteMany({
    where: { shop, orderId: { in: orderIdStrings } },
  });

  await db.webhookDelivery.deleteMany({
    where: { shop, resourceId: { in: orderIdStrings } },
  });

  const allOutbound = await db.outboundEventDelivery.findMany({
    where: { shop },
    select: { id: true, payloadJson: true },
  });

  const idsToDelete: string[] = [];
  for (const row of allOutbound) {
    try {
      const p = JSON.parse(row.payloadJson) as { order?: { id?: string } };
      const oid = p.order?.id;
      if (oid != null && orderIdStrings.includes(String(oid))) {
        idsToDelete.push(row.id);
      }
    } catch {
      /* skip */
    }
  }

  if (idsToDelete.length > 0) {
    await db.outboundEventDelivery.deleteMany({
      where: { id: { in: idsToDelete } },
    });
  }
}
