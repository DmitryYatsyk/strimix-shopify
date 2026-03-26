import type { LoaderFunctionArgs } from "react-router";
import { getCustomerDataRequestExportById } from "../lib/compliance.server";
import { authenticate } from "../shopify.server";

/**
 * GET /app/customer-data/:id — download JSON export for a customers/data_request row.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = params.id?.trim();
  if (!id) {
    throw new Response("Not found", { status: 404 });
  }

  const row = await getCustomerDataRequestExportById(session.shop, id);

  if (!row) {
    throw new Response("Not found", { status: 404 });
  }

  const filename = `strimix-customer-data-${row.shopifyCustomerId}-${row.id}.json`;

  return new Response(row.exportJson, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
};
