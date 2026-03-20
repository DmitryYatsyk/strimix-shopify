import type { ActionFunctionArgs } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { savePixelOrderAvid, sendPixelBeginCheckout } from "../lib/strimix.server";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  } else {
    headers["Access-Control-Allow-Origin"] = "*";
  }
  return headers;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: new Headers(corsHeaders(request)) });
  }
  return new Response(null, { status: 404, headers: new Headers(corsHeaders(request)) });
};

type PixelEventBody = {
  shop?: string;
  pixel_token?: string;
  event_name: "begin_checkout" | "purchase";
  strimix_avid?: string | null;
  avid_source?: string | null;
  email?: string | null;
  phone?: string | null;
  order_id?: string;
  products?: Array<{ id: string; name: string; quantity: number; value: number; currency?: string }>;
};

/**
 * Public endpoint: POST /pixel-events
 * Called from Web Pixel (checkout_started → begin_checkout, checkout_completed → purchase).
 *
 * Auth: shop + pixel_token (stored in ShopSettings.pixelToken and injected into Web Pixel settings).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const origin = request.headers.get("origin");
  const headers = { ...JSON_HEADERS, ...corsHeaders(request) } as Record<string, string>;
  if (origin && !headers["Access-Control-Allow-Origin"]) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: new Headers(headers) });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers,
    });
  }

  let body: PixelEventBody;
  try {
    body = (await request.json()) as PixelEventBody;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), { status: 400, headers });
  }

  const shop = typeof body.shop === "string" ? body.shop.trim() : "";
  const pixelToken = typeof body.pixel_token === "string" ? body.pixel_token.trim() : "";
  if (!shop || !pixelToken) {
    return new Response(JSON.stringify({ ok: false, error: "shop and pixel_token required" }), { status: 401, headers });
  }

  const settingsRow = await db.shopSettings.findUnique({ where: { shop } });
  const beginCheckoutEnabled =
    (settingsRow as { clientEventBeginCheckout?: boolean | null } | null)?.clientEventBeginCheckout ?? true;
  const expectedToken = (settingsRow as { pixelToken?: string | null } | null)?.pixelToken ?? null;
  if (!settingsRow) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 403, headers });
  }
  if (!expectedToken || expectedToken !== pixelToken) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 403, headers });
  }

  const event_name = body.event_name;
  const strimix_avid = typeof body.strimix_avid === "string" ? body.strimix_avid.trim() || null : null;
  const avid_source = typeof body.avid_source === "string" ? body.avid_source.trim() || null : null;

  if (event_name === "begin_checkout") {
    if (!beginCheckoutEnabled) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), { status: 200, headers });
    }
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
      return new Response(JSON.stringify({ ok: false, error: "order_id and strimix_avid required for purchase" }), {
        status: 400,
        headers,
      });
    }
    await savePixelOrderAvid(shop, order_id, strimix_avid, avid_source);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ ok: false, error: "Unknown event_name" }), { status: 400, headers });
};
