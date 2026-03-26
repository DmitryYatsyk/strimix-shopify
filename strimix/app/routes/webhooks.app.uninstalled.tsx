import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteAllShopData } from "../lib/compliance.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);

  // Idempotent: delete all persisted shop data (sessions, settings, outbound queue, GDPR rows, …).
  await deleteAllShopData(shop);

  return new Response();
};
