import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getInlineTrackerScript,
  getTrackingLogicScript,
} from "../lib/loader-script.server";
import { getSettingsForPublicTracker } from "../lib/settings.server";

function normalizeShop(shop: string) {
  return shop.trim().toLowerCase();
}

const JS_HEADERS = {
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
} as const;

/**
 * Serves the full Strimix tracker script. Called via App Proxy from the storefront
 * (store.com/apps/strimix/embed.js -> app/apps/strimix/embed.js).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const url = new URL(request.url);
    let shop = normalizeShop(url.searchParams.get("shop") || "");

    if (url.searchParams.has("signed")) {
      try {
        const { session } = await authenticate.public.appProxy(request);
        if (session?.shop) shop = normalizeShop(session.shop);
      } catch {
        return new Response("/* invalid proxy signature */", {
          status: 401,
          headers: JS_HEADERS,
        });
      }
    }
    if (!shop) shop = normalizeShop(url.searchParams.get("shop") || "");

    if (!shop) {
      return new Response("/* missing shop */", {
        status: 400,
        headers: JS_HEADERS,
      });
    }

    const config = await getSettingsForPublicTracker(shop);
    if (!config.enabled || !config.streamId) {
      const reason = !config.enabled
        ? "Enable tracking in app settings"
        : "Set Stream ID in app settings";
      const diagnostic =
        "window.__StrimixEmbedConfig={_disabled:true,_reason:" +
        JSON.stringify(reason) +
        "};/* Strimix: " +
        reason +
        " */";
      return new Response(diagnostic, {
        status: 200,
        headers: JS_HEADERS,
      });
    }

    const configSnippet =
      "window.__StrimixEmbedConfig={events:" +
      JSON.stringify(config.events) +
      "};\n";
    const script =
      configSnippet +
      "window.__StrimixEmbedLoaded=true;\n" +
      getInlineTrackerScript(config.streamId, config.cookieName) +
      "\n" +
      getTrackingLogicScript();

    return new Response(script, {
      status: 200,
      headers: JS_HEADERS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(
      "/* Strimix embed error: " + message.replace(/\*\//g, "* /") + " */",
      { status: 500, headers: JS_HEADERS },
    );
  }
};
