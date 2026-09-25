/**
 * Catalog GIDs in page URLs: gid://shopify/MarketCatalog/123 becomes
 * "MarketCatalog-123". Only Market and B2B catalogs are accepted, because the
 * app doesn't manage sales channel catalogs (AppCatalog).
 */
const CATALOG_TYPES = ["MarketCatalog", "CompanyLocationCatalog"] as const;
const GID = /^gid:\/\/shopify\/(MarketCatalog|CompanyLocationCatalog)\/(\d+)$/;
const PARAM = /^(MarketCatalog|CompanyLocationCatalog)-(\d+)$/;

export function toCatalogParam(gid: string): string | null {
  const match = GID.exec(gid);
  return match ? `${match[1]}-${match[2]}` : null;
}

export function fromCatalogParam(param: string | undefined): string | null {
  const match = PARAM.exec(param ?? "");
  if (
    !match ||
    !CATALOG_TYPES.includes(match[1] as (typeof CATALOG_TYPES)[number])
  )
    return null;
  return `gid://shopify/${match[1]}/${match[2]}`;
}
