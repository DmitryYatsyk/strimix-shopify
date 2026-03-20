/**
 * Runs a background interval to process due outbound events for all shops.
 * Started when the server loads (see shopify.server.ts import).
 * Tracking permission is governed by Shopify API; this only sends already-queued events.
 */

import {
  getShopsWithDueOutboundEvents,
  processDueOutboundEvents,
} from "./lib/strimix.server";

const INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

function run() {
  getShopsWithDueOutboundEvents()
    .then((shops) => {
      for (const shop of shops) {
        void processDueOutboundEvents(shop).catch(() => {
          /* ignore */
        });
      }
    })
    .catch(() => {
      /* ignore */
    });
}

if (typeof setInterval !== "undefined") {
  run();
  setInterval(run, INTERVAL_MS);
}
