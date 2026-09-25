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
- Postgres via Prisma (`prisma/schema.prisma`), Redis for the job queue (BullMQ). Both
  run locally with `docker compose` (`npm run db:up`); the worker process needs
  `npm run worker` running alongside `npm run dev`.
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
19. A catalog created in the 2026 admin **always gets a publication**, starting with
    every product (filled by a `PublicationResourceOperation` that is ACTIVE for a
    short while): "Automatically add new products" ticked gives `autoPublish: true`,
    unticked gives `autoPublish: false`. A null publication (finding 3) therefore only
    comes from older catalogs or API-created ones, so managed mode's
    publication-creating path is untested on the dev store. Syncs are refused while a
    catalog operation is CREATED or ACTIVE (managed mode test, Sep 2026).
20. **`read_companies` alone is enough for company/location assignment data, with no
    `read_customers`**: confirmed live on the dev store (Sep 2026) with only
    `read_companies` granted, for the top-level `companyLocations` and `companies`
    queries, `CompanyLocation.metafields`, `Company.metafields` (read through
    `CompanyLocation.company`), and `CompanyLocation.catalogs`. This matters because a
    static GraphQL schema validator reported `read_customers` as a required scope for
    the same fields; that's wrong (or at least overly conservative) for this store, so
    trust a live probe over the validator's declared scopes when they disagree. Confirms
    the "stay clear of customer data" design decision for B2B assignment rules
    (Phase 2) is achievable as planned.

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
- `app/lib/assignment/conditions.ts`, `evaluate.ts` (Phase 2): B2B catalog assignment
  rules. Metafield-only conditions (`company_metafield`, `location_metafield`) and an
  evaluator that decides which company locations get access to a catalog, mirroring
  `app/lib/rules` but with no exclude group or overrides (assignment is additive only).
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
- `app/lib/queue/connection.server.ts`: one Redis connection per Queue/Worker instance.
  `queues.server.ts`: job data types, the `product-index-recheck` and `catalog-sync`
  queues, and scheduling helpers. Job IDs use `|` as the separator, never `:` (BullMQ
  rejects a custom ID containing `:` unless it splits into exactly 3 parts, and Shopify
  GIDs contain `:`). `upsertDelayedJob` debounces by removing any existing job with the
  same ID before adding the delayed replacement. `CATALOG_SYNC_DEBOUNCE_MS` is 2 minutes,
  confirmed end to end on the dev store (Sep 2026): a tag edit's webhook queued a debounced
  job that fired 2 minutes later and re-synced the affected managed catalog with no
  manual click. `app/worker.ts`: the standalone worker process (`npm run worker`, tsx with
  `--watch`) that runs both queues; `unauthenticated.admin(shopDomain)` builds each job's
  admin client (offline session storage, handles token refresh), since the worker has no
  request context.

## Phase 1 next steps

1. Done: app runs on the dev store; scopes settled; latency and cost recorded above.
2. ~~Product index~~: done and tested on the dev store (Sep 2026). Bulk rebuild on
   install and from Diagnostics; products and collections webhooks; delayed re-reads
   for collection conditions (findings 14 to 17).
3. ~~Rule evaluator~~: done and tested on the dev store (Sep 2026), with a preview-only
   rule builder (tag, vendor, product type, title, collection, status, Online Store),
   plus metafield conditions (PR #3). Still open: a category picker (the evaluator
   already supports category), and possibly the "not visible" warning for Market
   catalogs (only B2B was checked on the storefront, finding 6).
4. ~~Managed mode~~ (`app/lib/sync/plan.ts`, `apply.server.ts`, `managed.server.ts`): done
   and tested on the dev store (Sep 2026), PR #4. "Apply to Shopify" on the rules page.
   Uses the saved rules; creates the publication if missing, turns autoPublish off,
   applies 50 + 50 chunks (rejected chunks are halved to isolate bad products, capped at
   40 rejected calls), writes the audit log and the drift baseline. Safety: the merchant
   confirms the counts (re-checked on the server), removals of more than 25% or 100
   products and empty results need an extra tick, the index must be built, syncs are
   refused while Shopify is still changing the catalog (finding 19), one sync per catalog
   at a time (row-locked), and **development stores only** until step 5 is tested. Syncs
   run in-process for now (a restart interrupts them); catalogs change only on Apply or
   Sync now. "Stop managing" leaves products and autoPublish as they are. The page polls
   `app/routes/app.sync-status.$catalogId.tsx` (database only, no Shopify calls) while a
   sync runs and revalidates once it ends; a very fast sync (e.g. 0 changes) can finish
   before the first poll, so the result can lag a few seconds behind the click, via
   React Router's default revalidation after the fetcher submission, not a bug.
   Untested: creating a publication for a catalog that has none (finding 19: the 2026
   admin always creates one, so the dev store has no such catalog).
5. ~~Queue~~ (`app/lib/queue`, `app/worker.ts`): done and tested end to end on the dev
   store (Sep 2026). Product and collection webhooks schedule their existing recheck
   delays on BullMQ instead of in-process timers, and unconditionally schedule a debounced
   sync for every managed catalog on the shop (coarse for v1: any product change re-syncs
   every managed catalog, not just the ones whose rules could be affected). Automatic
   syncs use `SyncCause.WEBHOOK`; a synthetic acknowledgement is built from the freshly
   computed plan (no merchant confirmation for automatic runs), so the same safety checks
   in `managed.server.ts` (large-removal pause, one sync per catalog) still apply.
   `runAutomaticSync` re-reads the catalog live (`loadRuleCatalog`) rather than trusting
   cached DB fields, so a merchant re-enabling "Automatically add new products" takes
   effect immediately. Requires `npm run worker` running (a separate terminal in dev);
   syncs no longer run in-process on the web server.

## Phase 2 next steps

**B2B catalog assignment rules** (idea from Dan, Sep 2026, started Sep 2026). Today a
merchant assigns a B2B catalog to each company location by hand. The app shows every
assignment and assigns catalogs automatically from rules, e.g. "locations whose company
has `custom.customer_type = wholesale` get the Wholesale catalog". Checked against the
2026-07 schema:

- Assign with `catalogContextUpdate(catalogId, contextsToAdd/contextsToRemove:
  { companyLocationIds })`. Needs **`write_products`** (not requested today): adding the
  scope means an existing install's merchant must re-consent (scope update flow).
- Rule data: `Company.metafields` and `CompanyLocation.metafields` (with
  `read_companies`). Companies and locations have **no tags** field.
- A catalog's contexts can only be markets or company locations: there is **no
  customer segment or customer tag context**, so assigning by segment/customer tag
  (which needs `read_customers`, protected customer data) stays out of scope.
- Only Plus shops can have `CompanyLocationCatalog`s (finding 11), so this is a Plus
  feature.

Design decisions (Sep 2026):

- **A location can match more than one catalog.** No "exactly one winner" rule: rules
  are evaluated independently per catalog, same as product rules today, so a location
  simply gets added wherever it matches.
- **Additive only, never reconciled.** Applying rules only adds `CompanyLocationCatalog`
  contexts for locations that match; it never removes a context a merchant (or a
  previous rule run) already set, even if no rule currently matches it. No "drift"
  concept here, unlike managed mode's product sync.
- **Manual apply first.** Ship preview + a merchant-confirmed "Apply assignments" action
  (same shape as managed mode's original step 4); a scheduled automatic re-scan is a
  later step once manual is tested, not built in the same phase. `company_locations/*`
  webhooks stay unused (protected customer data): reacting to new locations means a
  scheduled scan, not a webhook.
- **Reuse the existing rule engine.** Company/location counts are far smaller than
  product counts, so v1 reads them live (paginated GraphQL) at preview/apply time rather
  than building a bulk index like the product index.
- Record the plan change in the claude.ai project plan too (it's the working copy).

Steps:

1. ~~Data model and evaluator~~: done and tested (Sep 2026), not yet on the dev store.
   Added `ASSIGNMENT` to `RuleSetKind` (alongside `CATALOG`/`TEMPLATE`), so a
   `COMPANY_LOCATION` catalog can hold two independent rule sets: the existing product
   include/exclude rules (which products the catalog contains), and a new assignment
   rule set (which company locations get access to it). `RuleSet`'s `@unique` on
   `catalogId` widened to `@@unique([catalogId, kind])`. The assignment rule set only
   has an include group for v1 (no exclude), with its own field vocabulary
   (`company_metafield`, `location_metafield`, both metafield-only per the "no tags"
   finding above): `app/lib/assignment/conditions.ts`, `evaluate.ts`. The metafield
   matching itself is shared with product rules (`matchesMetafieldCondition`, exported
   from `app/lib/rules/evaluate.ts`): company and location metafields are indexed the
   same shape as product metafields (`IndexedMetafields`).
2. ~~Data layer~~: done and tested live against the dev store (Sep 2026, confirmed
   finding 20 above). `app/lib/assignment/locations.server.ts`: the top-level
   `companyLocations(first, after)` query (not `company.locations`, to avoid an N+1
   read per company), each location's `company { id name metafields }`, its own
   `metafields`, and its `catalogs { nodes { id } }` for current context (the additive
   diff). Paginated the same way as `listCollections`/`listMetafieldDefinitions`.
3. Rule builder UI and a preview page (locations, their current contexts, what the rules
   would assign), reusing the product rule builder's shape where it fits.
4. Apply: `catalogContextUpdate`, additive only (per the design decision above). Needs
   the `write_products` scope added and the existing-install re-consent flow.
5. Automatic re-scan (later step, same shape as the job queue): a scheduled scan, no
   `company_locations/*` webhooks.

## Planned features (not yet scheduled)

**Sidekick integration** (idea from Dan, Sep 2026). **Decided: a requirement**, not
optional. Goal: a merchant can type a prompt like "make a catalog for VIP users, company
or location metafield of custom_user_type = vip and products tagged vip" into Sidekick
and get a catalog built from that. Checked against the Sidekick app extensions docs
(shopify.dev, Sep 2026; the feature itself shipped December 2025):

- Sidekick app extensions have two layers. Fixed resource "intent types"
  (`application/email`, `ad`, `campaign`, `faq`, `loyalty-program`, `quote`, `return`,
  `review`, `shipment`, `ticket`, plus `shopify/*` resource imports) don't cover
  catalogs or collection rules, so that layer doesn't fit. Each extension can also
  register up to 20 free-form **tools** (`tools.json`: name, description, JSON-schema
  `inputSchema`, ordinary LLM function-calling) that Sidekick's model fills in from the
  merchant's prompt itself. That's the fit: a `create_managed_catalog` tool whose
  `inputSchema` mirrors the app's rule model (catalog name/type, include/exclude
  conditions: field, operator, value) lets Sidekick parse the prompt straight into
  structured conditions without the app doing any NLP.
- Needs a new `admin_link` or `admin_action` extension (`admin.app.intent.link` or
  `.render`) with `tools.json` and an `instructions.md` telling Sidekick when to reach
  for it, plus `[sidekick] extensions_summary` in `shopify.app.toml`.
- A new route receives the structured data (query params or hash, per the intent
  schema's `mapTo`/`fieldName`) and turns it into `Include`/`Exclude` condition rows,
  landing the merchant on the rule builder **pre-filled but not applied**: keep the same
  "merchant confirms before anything touches Shopify" pattern managed mode already uses,
  rather than Sidekick creating and syncing a catalog unsupervised.
- Requires Shopify CLI 3.90+, API version 2026-04+ for the inline `.render` target
  (2026-07 already in use here), and a CORS allowlist update for the Sidekick sandbox.
- App Store review requires the extension's declared scope, `tools.json` descriptions
  and runtime behaviour to stay materially consistent (guideline 2.2.8): the tool must
  stay narrowly "catalog and rule creation", not a general-purpose action.
- Schedule after the Phase 1 QC pass; scope the exact tool schema and the prompt-to-rule
  mapping (including which condition fields/operators a v1 tool should expose) as a
  dedicated step before building.

## Dev store

"Catalog Manager Test" (catalog-manager-test.myshopify.com), Shopify Plus App Development
plan. Fixtures from the spike: Canada market catalog, "Spike: Powderbound trade" B2B
catalog (Powderbound company, Dan is a contact), 140 products (120 tagged `spike-seed`
with vendors, types, market tags and a `custom.trade_tier` metafield), and a
"Spike: Driftline (smart)" collection. Added during managed mode testing (Sep 2026):
"Sync Test" and "Sync Test 2" Market catalogs (United States), both created via the
admin so both got a publication (finding 19); safe to delete or reuse. Two companies,
each with one location, checked during Phase 2's data layer work (Sep 2026): Powderbound
(location assigned to the "Spike: Powderbound trade" catalog) and Snowdevil (location
with no catalog context yet). Neither has any metafields set yet; add some (e.g.
`custom.customer_type`) before testing assignment rules end to end.

## Commands

- `npm run db:up` / `npm run db:down`: start/stop Postgres and Redis (Docker).
- `npm run db:migrate`: create/apply migrations in development.
- `npm run dev`: `shopify app dev` (tunnel, auth, runs migrations).
- `npm run worker`: the BullMQ worker (`app/worker.ts`), a separate terminal alongside
  `npm run dev`. Needs `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` in `.env` (`npm run env`,
  i.e. `shopify app env pull`, since `shopify app dev` only injects them into its own
  child process) and a non-empty `SHOPIFY_APP_URL` (any placeholder works; the worker
  never runs the OAuth/install flow that actually uses it).
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.

Windows gotcha: `npm run dev`'s pre-dev `prisma generate` step can fail with
`EPERM: operation not permitted, rename ... query_engine-windows.dll.node` if another
Node process still holds the Prisma client open (the worker, or a leftover script from a
killed/backgrounded run) when `dev` restarts. A failed `prisma generate` here takes down
the whole `shopify app dev` process, including webhook delivery, with no obvious link
back to the real cause. Find and kill the stray process (`Get-CimInstance Win32_Process
-Filter "Name='node.exe'"` to see command lines) before assuming webhooks are broken.
