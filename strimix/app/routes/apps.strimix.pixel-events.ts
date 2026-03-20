import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { sendPixelBeginCheckout, savePixelOrderAvid } from "../lib/strimix.server";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

type PixelEventBody = {
  event_name: "begin_checkout" | "purchase";
  strimix_avid?: string | null;
  avid_source?: string | null;
  email?: string | null;
  phone?: string | null;
  order_id?: string;
  products?: Array<{ id: string; name: string; quantity: number; value: number; currency?: string }>;
};

/**
 * App Proxy only (signed requests from Shopify). Web Pixel in checkout must call
 * https://<app-host>/pixel-events with shop + pixel_token — not this path from the browser.
 *
 * App Proxy: POST /apps/strimix/pixel-events
 * Receives events from Web Pixel (checkout_started → begin_checkout, checkout_completed → purchase).
 * begin_checkout: forward to Strimix. purchase: save order_id + strimix_avid for webhook linking (dedup with server new_order).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const origin = request.headers.get("origin");
  const headers = { ...JSON_HEADERS } as Record<string, string>;
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers,
    });
  }

  try {
    const { session } = await authenticate.public.appProxy(request);
    const shop = session?.shop;
    if (!shop) {
      return new Response(JSON.stringify({ ok: false, error: "invalid_proxy" }), {
        status: 401,
        headers,
      });
    }

    let body: PixelEventBody;
    try {
      body = (await request.json()) as PixelEventBody;
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
        status: 400,
        headers,
      });
    }

    const event_name = body.event_name;
    const strimix_avid = typeof body.strimix_avid === "string" ? body.strimix_avid.trim() || null : null;
    const avid_source = typeof body.avid_source === "string" ? body.avid_source.trim() || null : null;

    if (event_name === "begin_checkout") {
      await sendPixelBeginCheckout(shop, {
        strimix_avid,
        email: typeof body.email === "string" ? body.email : null,
        phone: typeof body.phone === "string" ? body.phone : null,
        products: body.products ?? [],
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    if (event_name === "purchase") {
      const order_id = body.order_id?.trim();
      if (!order_id || !strimix_avid) {
        return new Response(
          JSON.stringify({ ok: false, error: "order_id and strimix_avid required for purchase" }),
          { status: 400, headers },
        );
      }
      await savePixelOrderAvid(shop, order_id, strimix_avid, avid_source);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ ok: false, error: "Unknown event_name" }), {
      status: 400,
      headers,
    });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Server error" }), {
      status: 500,
      headers: { ...JSON_HEADERS } as Record<string, string>,
    });
  }
};
