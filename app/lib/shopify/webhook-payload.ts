/**
 * Webhook payloads are in REST format. Most carry `admin_graphql_api_id`, but
 * delete payloads can carry only the numeric `id`, so build the GID from that.
 */
export function payloadGid(payload: unknown, resource: "Product" | "Collection"): string | null {
  const { admin_graphql_api_id: gid, id } = (payload ?? {}) as {
    admin_graphql_api_id?: unknown;
    id?: unknown;
  };
  const prefix = `gid://shopify/${resource}/`;

  if (typeof gid === "string" && gid.startsWith(prefix)) return gid;
  if ((typeof id === "number" || typeof id === "string") && /^\d+$/.test(String(id))) {
    return `${prefix}${id}`;
  }
  return null;
}
