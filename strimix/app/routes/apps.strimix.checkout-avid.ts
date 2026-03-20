import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const COOKIE_NAME = "sx_uid";
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

/**
 * Returns strimix_avid from the request Cookie (sx_uid).
 * Used by Checkout UI Extension to set order attribute when checkout runs on a domain that sends the cookie.
 * Called via App Proxy: GET /apps/strimix/checkout-avid
 */
function parseAvidFromCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`),
  );
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? decodeURIComponent(value) : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    let shop: string | null = null;
    if (request.url.includes("signed") || request.headers.get("x-shopify-app-proxy")) {
      try {
        const { session } = await authenticate.public.appProxy(request);
        shop = session?.shop ?? null;
      } catch {
        return new Response(
          JSON.stringify({ strimix_avid: null, error: "invalid_proxy" }),
          { status: 401, headers: JSON_HEADERS },
        );
      }
    }
    const cookieHeader = request.headers.get("cookie");
    const strimix_avid = parseAvidFromCookie(cookieHeader);
    const origin = request.headers.get("origin");
    const headers = { ...JSON_HEADERS } as Record<string, string>;
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    return new Response(JSON.stringify({ strimix_avid }), {
      status: 200,
      headers,
    });
  } catch {
    return new Response(
      JSON.stringify({ strimix_avid: null }),
      { status: 200, headers: JSON_HEADERS },
    );
  }
};
