import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  redactCustomerOrders,
  type CustomersRedactPayload,
} from "../lib/compliance.server";
import { markWebhookReceived } from "../lib/strimix.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  const p = payload as CustomersRedactPayload;
  const eventId =
    request.headers.get("x-shopify-event-id") ??
    `${shop}:${topic}:${p?.customer?.id ?? ""}`;

  const accepted = await markWebhookReceived({
    shop,
    eventId,
    topic,
    resourceId: p?.customer?.id != null ? String(p.customer.id) : undefined,
  });

  if (!accepted) return new Response();

  await redactCustomerOrders(shop, p);

  console.info(`[strimix] GDPR customers/redact processed shop=${shop}`);

  return new Response();
};
