import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Mandatory compliance webhooks for public apps.
 *
 * The app stores no customer data (only products, catalogs and rules), so the
 * two customer topics have nothing to return or delete. shop/redact is sent
 * 48 hours after uninstall and removes everything stored for the shop.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      // No customer data stored.
      break;
    case "SHOP_REDACT":
      await db.session.deleteMany({ where: { shop } });
      // Catalogs, rules, overrides, product index and logs cascade from Shop.
      await db.shop.deleteMany({ where: { domain: shop } });
      break;
    default:
      console.warn(`Unexpected compliance topic ${topic}`);
  }

  return new Response();
};
