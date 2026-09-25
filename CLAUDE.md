@AGENTS.md

# Smart Catalogs (shopify-catalog-manager)

Public Shopify app (working name "Smart Catalogs") that adds smart-collection-style
include/exclude rules to Market and B2B catalogs and keeps each catalog's product list
in sync automatically. Owner: Dan, as his own product (personal Shopify Partner/Dev Dashboard organisation, not Quickfire Digital).

The full plan (v2) and the phase 0 spike findings live in the claude.ai project
"Shopify Catalog Manager App" (`claude/smart-catalogs-app-plan.md` and
`claude/smart-catalogs-spike-findings.md`). The project copy of the plan is the working
version. The essentials are summarised below so work here doesn't depend on them.

## Writing style

- British English in docs, comments and commit messages. Shopify product terms keep
  Shopify's spelling ("catalog", "Online Store").
- No em dashes.

## Stack

- Shopify React Router app template (TypeScript), `@shopify/shopify-app-react-router`,
  Admin API version 2026-07.
- Polaris web components (`<s-page>`, `<s-section>`, `<s-table>` etc.) in the embedded admin.
- Postgres via Prisma (`prisma/schema.prisma`), Redis for the job queue (BullMQ, not added
  yet). Both run locally with `docker compose` (`npm run db:up`).
- Tests: Vitest (`npm test`), unit tests next to the code as `*.test.ts`.
- npm only (commit `package-lock.json`).

## Confirmed platform behaviour (from the spike, Sep 2026)

These were tested on the Plus dev store and should be treated as facts unless a new test
shows otherwise:

1. `publicationUpdate` takes at most **50 adds and 50 removes per call** (separate limits,
   so 100 changes). It's synchronous and **all or nothing**: over the limit returns
   `PUBLICATION_UPDATE_LIMIT_EXCEEDED` and applies nothing. Use
   `app/lib/sync/chunk.ts`; retry failed chunks whole.
2. **No webhook fires for catalog membership changes.** `product_publications/*` only
   covers the app's own channel. Drift is detected by polling each managed catalog's
   latest `operations { id }`, `includedProductsCount` and `autoPublish`:
   - every admin save creates one new `PublicationResourceOperation` (`rowCount` = number
     of products changed), including count-neutral edits;
   - the app's own `publicationUpdate` calls, `autoPublish` toggles and auto-published
     additions create **no** operation.
   Keep a nightly full reconcile as the backstop (other apps' API edits leave no operation).
3. A catalog's `publication` can be **null** (availability then follows the sales channel
   and the admin shows everything as Included). The admin creates a publication with
   `autoPublish: false` the first time a merchant excludes a product. Managed mode must
   create one when missing: `publicationCreate(catalogId, defaultState: ALL_PRODUCTS,
   autoPublish: false)`, then wait for the `AddAllProductsOperation` to complete.
4. Once a catalog has its own publication with `autoPublish: false`, **new products never
   reach it**, even when published to every sales channel. This is the core problem the
   app solves, so `products/create` handling is essential.
5. `autoPublish: true` adds every new product automatically (even products on no channel).
   Managed catalogs must keep it **off**. It's the basis of the planned free tier.
6. A B2B buyer only sees a product that is **in their catalog AND published to the Online
   Store channel** (checked on the storefront: either one missing gives a 404). Flag
   "in catalog but not visible" products; don't count them as live.
7. Catalog publications can **only contain products** (`UNSUPPORTED_PUBLISHABLE_TYPE` for
   collections). "In collection" is a rule condition resolved from the app's index.
8. Admin product search lags behind writes. Evaluate rules against the app's own product
   index (bulk operation on install + webhooks), never live admin search.
9. `includedProducts` = membership (includes drafts and archived); `products` = the
   visible subset. **Diff against `includedProducts`.**
10. Swapping a catalog's publication with `catalogUpdate` orphans the old one. Always
    reuse the existing publication.
11. B2B is available on all plans, but non-Plus shops are capped at 3 active B2B catalogs
    and can't use `CompanyLocationCatalog`. Gate by catalog type and count.
12. The `catalogs` query also returns `AppCatalog`s (sales channels). Hide them.
13. `Product.resourcePublicationsV2` lists sales channels by default; pass
    `catalogType: MARKET` or `COMPANY_LOCATION` to see catalog membership.
14. Adding a product to a sales channel (e.g. the Online Store) fires `products/update`
    and moves `Product.updatedAt` forward (product index test, Sep 2026).
15. Adding a product to a collection by hand always fires `collections/update` (the
    payload doesn't list the products), but **not reliably** `products/update`: one test
    fired both, another only the collection webhook. The index refreshes
    `collectionIds` from the collection side (`webhooks.collections.tsx`) (product
    index test, Sep 2026).
16. Membership from a collection's **conditions** is updated **after** the product
    save, with no `collections/update`, and it can take over 30 seconds: a read 2
    seconds after `products/update` missed an addition, a read 30 seconds after missed a
    removal, and both had happened a few minutes later. Timed with re-reads: an addition
    and a removal each landed **between 30 s and 2 min** after the save. Product and
    collection webhooks schedule re-reads at 30 s, 2 min and 10 min
    (`scheduleProductRecheck`, `scheduleCollectionRecheck`; move to BullMQ in step 5),
    so condition-based membership in the index can lag by up to about 2 minutes
    (product index test, Sep 2026).
17. From 2026-07 there are no separate "smart" and "manual" collection types: one
    collection can combine conditions, manually included products and exclusions
    (`Collection.sources` replaces `ruleSet`; `collection_type` filter removed). Never
    branch on collection type; read final membership (`Collection.products`,
    `Product.collections`), which both work on 2026-07. The claude.ai Shopify schema
    tool still showed `ruleSet` and not `sources` in Sep 2026, so it may lag the
    2026-07 schema: confirm new queries in GraphiQL on 2026-07 as well. (The local
    `shopify-dev-mcp` validator, pinned to 2026-07, does know `sources`.)
18. Editing a product metafield in the admin fires `products/update` and moves
    `Product.updatedAt` forward, so the products webhook keeps indexed metafields
    current (metafield conditions test, Sep 2026).

## Scopes and webhooks (settled Sep 2026, Diagnostics on the dev store)

Minimum scopes, all confirmed working: `read_products, read_publications,
write_publications, read_markets, read_companies`. Market names don't need
`write_markets`; company/location names don't need `read_customers`.
`write_products` is only needed if the app ever creates catalogs.

`company_locations/*` webhooks are deliberately not subscribed: Shopify classes them as
protected customer data, and the app avoids holding customer data. The catalog list is
read live instead.

Gotcha: `shopify app config link` rewrites `shopify.app.toml` from the remote app. On a
new app it blanked `scopes` and bumped the webhook `api_version`; check both after linking.

## Measured performance (real app token, Plus dev store)

- Catalog list query: ~250 to 370 ms, actual cost 13.
- Market or company name lookups: ~240 to 250 ms, cost 6.
- Online Store status for 5 products: 340 ms, cost 20, so collect this in the bulk
  export for the product index rather than per product.
- `publicationUpdate` with 1 product: ~320 ms, cost 20 (remove and re-add both
  passed). Not yet measured with a full 50 + 50 chunk.
- The app's own `publicationUpdate` calls created no catalog operation (confirmed again
  with the real app token), so the drift signal holds.
- Throttle bucket on the Plus dev store: 20,000 points. Non-Plus stores have much less,
  so the queue must read `extensions.cost.throttleStatus` and back off.

## Rule model

`In catalog = (Include AND NOT Exclude AND NOT Blocked) OR Pinned`. Include and exclude
groups each match ALL or ANY of their conditions. Default status handling: all statuses
(Shopify controls visibility of drafts itself).

## Code map

- `app/lib/sync/diff.ts`, `chunk.ts`: pure diff and publicationUpdate chunking (tested).
- `app/lib/shopify/graphql.server.ts`: `runGraphql` wrapper returning data, duration and
  `extensions.cost`.
- `app/lib/shopify/catalogs.server.ts`: catalog list (Market + B2B, hides AppCatalogs).
- `app/lib/shopify/diagnostics.server.ts`: scope probes and publicationUpdate timing.
- `app/lib/shop.server.ts`: Shop record upsert and plan gating values.
- `app/lib/product-index/products.ts`: pure part of the product index (query builders,
  bulk JSONL parsing, tested). `store.server.ts`: guarded upserts (a write never
  replaces newer `shopifyUpdatedAt` data, and `collectionIds` never replaces a newer
  `collectionsReadAt` read); `ProductIndexDeletion` records stop a running rebuild
  bringing deleted products back. `index.server.ts`: rebuild via
  bulkOperationRunQuery, finish on `bulk_operations/finish` (or the Diagnostics poll),
  single-product refresh for webhooks. The Online Store publication is found by catalog
  title, because `AppCatalog.apps` needs `read_product_listings`. On 2026-07 channel
  catalog titles read "Channel Catalog <id> for Online Store" (dev store, Sep 2026).
- `app/lib/rules/conditions.ts`: condition fields, operators and validation (the names
  the Condition table stores; the builder's menus read `FIELDS`). `evaluate.ts`: the pure
  evaluator with a reason per product. `preview.ts`: rule result vs current catalog
  membership. `rules.server.ts`: catalog, saved rules, collections and cached
  `includedProducts` for the builder. Text matching ignores case and surrounding spaces;
  an empty include group matches nothing; a rule set with any broken condition isn't
  evaluated at all.
- `app/lib/product-index/metafields.ts`: which product metafields the index keeps
  (text, numbers, booleans, lists of text; values up to 1,000 characters), stored in
  `ProductIndex.metafields` keyed by "namespace.key". Metafield conditions store
  `Condition.metafieldKey` and `metafieldType`; operators depend on the type
  (`METAFIELD_OPERATORS`). The builder lists product metafield definitions plus any
  indexed metafields without one. Rows written before metafields were indexed have
  none until the next rebuild.
- `app/routes/app._index.tsx`: Catalogs page. `app.diagnostics.tsx`: Diagnostics page.
  `app.catalogs.$catalogId.tsx`: rule builder with live preview (URL param from
  `app/lib/shopify/catalog-id.ts`, e.g. `MarketCatalog-123`). Saving writes only the
  app's database until managed mode.
- `app/routes/webhooks.*.tsx`: webhook handlers (products, collections, publications,
  catalog contexts, compliance, app lifecycle).

## Phase 1 next steps

1. Done: app runs on the dev store; scopes settled; latency and cost recorded above.
2. ~~Product index~~: done and tested on the dev store (Sep 2026). Bulk rebuild on
   install and from Diagnostics; products and collections webhooks; delayed re-reads
   for collection conditions (findings 14 to 17).
3. ~~Rule evaluator~~: done and tested on the dev store (Sep 2026), with a preview-only
   rule builder (tag, vendor, product type, title, collection, status, Online Store).
   Next: metafield conditions (index must store the metafields rules use), a category
   picker (evaluator already supports category), and possibly the "not visible" warning
   for Market catalogs (only B2B was checked on the storefront, finding 6).
4. Managed mode: create publication if missing, autoPublish off, diff, chunked apply.
5. Queue (BullMQ) and worker process; debounce product events.

## Planned features (not yet scheduled)

**B2B catalog assignment rules** (idea from Dan, Sep 2026). **Decided: the first feature
after Phase 1, using company and location data only** (metafields); no customer segments
or customer tags for now, so the app stays clear of customer data. Today a merchant assigns a
B2B catalog to each company location by hand. The app could show every assignment and
assign catalogs automatically from rules, e.g. "locations whose company has
`custom.customer_type = wholesale` get the Wholesale catalog". Checked against the
2026-07 schema:

- Assign with `catalogContextUpdate(catalogId, contextsToAdd/contextsToRemove:
  { companyLocationIds })`. Needs **`write_products`** (not requested today).
- Rule data: `Company.metafields` and `CompanyLocation.metafields` (with
  `read_companies`). Companies and locations have **no tags** field.
- A catalog's contexts can only be markets or company locations: there is **no
  customer segment or customer tag context**. Assigning by segment or customer tag would
  mean mapping customers (company contacts) to locations, which needs `read_customers`
  (protected customer data). That reverses the current "no customer data" stance, so
  decide deliberately.
- Reacting to new locations needs `company_locations/*` webhooks (protected customer
  data) or a scheduled scan of company locations.
- Only Plus shops can have `CompanyLocationCatalog`s (finding 11), so this is a Plus
  feature.
- Record the plan change in the claude.ai project plan too (it's the working copy).

## Dev store

"Catalog Manager Test" (catalog-manager-test.myshopify.com), Shopify Plus App Development
plan. Fixtures from the spike: Canada market catalog, "Spike: Powderbound trade" B2B
catalog (Powderbound company, Dan is a contact), 140 products (120 tagged `spike-seed`
with vendors, types, market tags and a `custom.trade_tier` metafield), and a
"Spike: Driftline (smart)" collection.

## Commands

- `npm run db:up` / `npm run db:down`: start/stop Postgres and Redis (Docker).
- `npm run db:migrate`: create/apply migrations in development.
- `npm run dev`: `shopify app dev` (tunnel, auth, runs migrations).
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
