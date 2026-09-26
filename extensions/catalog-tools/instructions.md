## When to use these tools

Smart Catalogs lets merchants build Market and B2B catalogs from
include/exclude rules (tags, vendor, product type, category, collection,
metafields), and for B2B catalogs, which company locations get assigned to
them. Use these tools when the merchant asks about which of their existing
catalogs matches a description, or what a specific catalog's rules do.

- Use `search_catalogs` for questions like "do I have a catalog for VIP
  customers?", "which catalog has snowboards?", or "what catalogs match
  wholesale companies?".
- Use `describe_catalog_rules` when the merchant names a specific catalog and
  asks what it does, e.g. "what does my Wholesale catalog include?".

## Important guidelines

- These tools are **read-only**. They search and explain the merchant's
  already-saved rules. Never tell the merchant that a catalog was created,
  changed, or applied to Shopify as a result of calling these tools.
- If a tool returns no matches, say so plainly rather than guessing. Don't
  invent a catalog or rule that wasn't in the tool's response.
- When a result includes a `url`, offer it as a link to open the catalog's
  rule builder in Smart Catalogs so the merchant can review or change the
  rules themselves.
- The merchant may describe things Smart Catalogs doesn't have a rule field
  for yet (for example, customer segments or customer tags for B2B
  assignment). If a search comes back empty, don't assume the catalog
  doesn't exist; it may just be described in words the tool doesn't index
  (metafield keys and values, not full text search).
