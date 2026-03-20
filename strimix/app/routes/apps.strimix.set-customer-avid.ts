import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { setCustomerStrimixAvid } from "../lib/strimix.server";

const COOKIE_NAME = "sx_uid";
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

function parseAvidFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`),
  );
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? decodeURIComponent(value) : null;
}

/**
 * POST body: { customerId: string | number, strimix_avid: string }.
 * Sets customer metafield strimix.avid so we can use it when order has no strimix_avid (e.g. Buy Now).
 * Call from storefront when customer is logged in (window.__StrimixCustomer.id). Optional: verify cookie matches body.
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
    let body: { customerId?: string | number; strimix_avid?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), {
        status: 400,
        headers,
      });
    }
    const customerId = body.customerId;
    const strimixAvid = typeof body.strimix_avid === "string" ? body.strimix_avid.trim() : "";
    if (customerId == null || customerId === "" || !strimixAvid) {
      return new Response(
        JSON.stringify({ ok: false, error: "customerId and strimix_avid required" }),
        { status: 400, headers },
      );
    }
    const cookieAvid = parseAvidFromCookie(request.headers.get("cookie"));
    if (cookieAvid != null && cookieAvid !== strimixAvid) {
      return new Response(JSON.stringify({ ok: false, error: "cookie_mismatch" }), {
        status: 400,
        headers,
      });
    }
    const result = await setCustomerStrimixAvid(shop, customerId, strimixAvid);
    if (!result.success) {
      return new Response(JSON.stringify({ ok: false, error: result.error }), {
        status: 400,
        headers,
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: "Server error" }),
      { status: 500, headers: { ...JSON_HEADERS } as Record<string, string> },
    );
  }
};
