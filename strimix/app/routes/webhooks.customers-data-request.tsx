import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  buildCustomerDataExportJson,
  persistCustomerDataRequest,
  type CustomersDataRequestPayload,
} from "../lib/compliance.server";
import { markWebhookReceived } from "../lib/strimix.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  const p = payload as CustomersDataRequestPayload;
  const eventId =
    request.headers.get("x-shopify-event-id") ??
    `${shop}:${topic}:${p?.data_request?.id ?? p?.customer?.id ?? ""}`;

  const accepted = await markWebhookReceived({
    shop,
    eventId,
    topic,
    resourceId: p?.customer?.id != null ? String(p.customer.id) : undefined,
  });

  if (!accepted) return new Response();

  const exportJson = await buildCustomerDataExportJson(shop, p);
  const customerId = p?.customer?.id != null ? String(p.customer.id) : "unknown";
  const ordersRequested = Array.isArray(p?.orders_requested) ? p.orders_requested : [];
  const dataRequestId =
    p?.data_request?.id != null ? String(p.data_request.id) : null;

  await persistCustomerDataRequest({
    shop,
    shopifyCustomerId: customerId,
    shopifyDataRequestId: dataRequestId,
    ordersRequestedJson: JSON.stringify(ordersRequested),
    exportJson,
    webhookEventId: eventId,
  });

  console.info(
    `[strimix] GDPR customers/data_request stored shop=${shop} customer=${customerId}`,
  );

  return new Response();
};
