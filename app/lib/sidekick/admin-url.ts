/**
 * Builds the admin URL for a catalog's rule builder page, for the Sidekick
 * tools to return as a plain link (`extensions/catalog-tools`). Needs the
 * app's handle, which isn't in shopify.app.toml and differs between the dev
 * and production apps, so it comes from an env var (see .env.example).
 */
export function adminCatalogUrl(
  shopDomain: string,
  catalogUrlParam: string | null,
): string | null {
  const appHandle = process.env.SHOPIFY_APP_HANDLE;
  if (!appHandle || !catalogUrlParam) return null;
  const storeHandle = shopDomain.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${storeHandle}/apps/${appHandle}/app/catalogs/${catalogUrlParam}`;
}
