import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteAllShopData } from "../lib/compliance.server";
import { markWebhookReceived } from "../lib/strimix.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  const p = payload as { shop_id?: number };
  const eventId =
    request.headers.get("x-shopify-event-id") ??
    `${shop}:${topic}:${p?.shop_id ?? ""}`;

  const accepted = await markWebhookReceived({
    shop,
    eventId,
    topic,
  });

  if (!accepted) return new Response();

  await deleteAllShopData(shop);

  console.info(`[strimix] GDPR shop/redact processed shop=${shop}`);

  return new Response();
};
