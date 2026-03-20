import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  buildOrderEventPayload,
  buildRefundEventPayload,
  enqueueOutboundEvent,
  fetchOrderByAdminGraphql,
  getShopStreamId,
  markWebhookReceived,
  processDueOutboundEvents,
} from "../lib/strimix.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);
  const eventId =
    request.headers.get("x-shopify-event-id") ?? `${shop}:${topic}:${payload?.id}:${payload?.order_id}`;
  const accepted = await markWebhookReceived({
    shop,
    eventId,
    topic,
    resourceId: payload?.id ? String(payload.id) : undefined,
  });

  if (!accepted) return new Response();

  const settings = await db.shopSettings.findUnique({ where: { shop } });
  if (!settings?.enabled || !settings.serverEventRefund) return new Response();
  if (!admin) return new Response();

  const streamId = await getShopStreamId(shop);
  if (!streamId) return new Response();

  let order: Awaited<ReturnType<typeof fetchOrderByAdminGraphql>> = null;
  try {
    order = await fetchOrderByAdminGraphql(admin, Number(payload?.order_id));
  } catch {
    /* order stays null */
  }
  if (!order) return new Response();

  try {
    const refundPayload = await buildRefundEventPayload(payload, order);
    await enqueueOutboundEvent({
      shop,
      eventName: "refund",
      streamId,
      payload: refundPayload,
      webhookEventId: eventId,
    });
    const updateOrderPayload = await buildOrderEventPayload("update_order", order);
    await enqueueOutboundEvent({
      shop,
      eventName: "update_order",
      streamId,
      payload: updateOrderPayload,
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
