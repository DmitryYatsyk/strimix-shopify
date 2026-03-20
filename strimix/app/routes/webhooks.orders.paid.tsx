import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  buildOrderEventPayload,
  enqueueOutboundEvent,
  fetchOrderByAdminGraphql,
  getPixelOrderAvidWithSource,
  getShopStreamId,
  markWebhookReceived,
  processDueOutboundEvents,
} from "../lib/strimix.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);
  const eventId = request.headers.get("x-shopify-event-id") ?? `${shop}:${topic}:${payload?.id}`;
  const accepted = await markWebhookReceived({
    shop,
    eventId,
    topic,
    resourceId: payload?.id ? String(payload.id) : undefined,
  });

  if (!accepted) return new Response();

  const settings = await db.shopSettings.findUnique({ where: { shop } });
  if (!settings?.enabled || !settings.serverEventNewOrder) return new Response();

  const streamId = await getShopStreamId(shop);
  if (!streamId) return new Response();

  let order: Parameters<typeof buildOrderEventPayload>[1] | null = null;
  if (admin && payload?.id != null && Number.isFinite(Number(payload.id))) {
    try {
      order = await fetchOrderByAdminGraphql(admin, Number(payload.id));
    } catch {
      /* fall back to webhook payload */
    }
  }
  const orderForPayload = order ?? (payload as Parameters<typeof buildOrderEventPayload>[1]);
  const orderId = payload?.id != null ? Number(payload.id) : undefined;
  const pixelRow =
    orderId != null && Number.isFinite(orderId) ? await getPixelOrderAvidWithSource(shop, orderId) : null;
  const pixelStrimixAvid = pixelRow?.strimixAvid ?? null;
  const pixelAvidSource = pixelRow?.avidSource ?? null;

  try {
    const eventPayload = await buildOrderEventPayload("new_order", orderForPayload, {
      pixelStrimixAvid: pixelStrimixAvid ?? undefined,
      pixelAvidSource: pixelAvidSource ?? undefined,
    });
    await enqueueOutboundEvent({
      shop,
      eventName: "new_order",
      streamId,
      payload: eventPayload,
      webhookEventId: eventId,
    });
  } catch {
    return new Response(null, { status: 500 });
  }

  await db.shopSettings.updateMany({
    where: { shop },
    data: {
      lastWebhookReceivedAt: new Date(),
      lastWebhookTopic: topic,
      lastWebhookEventId: eventId,
    },
  });

  void processDueOutboundEvents(shop);
  return new Response();
};
