@AGENTS.md

# Catalogic (shopify-catalog-manager)

Public Shopify app (working name "Catalogic") that adds smart-collection-style
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
21. **A Market's catalog does not gate storefront visibility the way a B2B catalog does
    (finding 6 doesn't extend to Markets)**: checked on the dev store (Sep 2026) using
    the "Sync Test" catalog (United States market). A product published to the Online
    Store channel but excluded from Sync Test's catalog still rendered its storefront
    product page normally under both the United States and Canada "view as" contexts (a
    plain product URL 404s only when the product isn't published to Online Store at
    all, regardless of any market catalog). So unlike B2B, there's no "in catalog AND on
    Online Store" condition for Markets: the Online Store publication is the only gate,
    the same as for any anonymous visitor. The rule builder's "not visible" flag
    (`checkVisibility` in `app/lib/rules/preview.ts`) is correctly B2B-only as it stands;
    no equivalent warning is needed for Market catalogs. Closes the last open item from
    Phase 1 step 3.

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
   plus metafield conditions (PR #3) and a category picker (search-as-you-type over
   Shopify's product taxonomy, tested end to end on the dev store Sep 2026: search,
   selection, persistence with the friendly breadcrumb name, and a working preview).
   Checked whether the "not visible" warning (finding 6) should extend to Market
   catalogs: it shouldn't, confirmed live on the dev store (Sep 2026, finding 21).
   Phase 1 is now complete.
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
3. ~~Rule builder UI and preview~~: done and tested end to end on the dev store (Sep
   2026). Added to the existing rule builder page (`app/routes/app.catalogs.$catalogId.tsx`),
   shown only for `COMPANY_LOCATION` catalogs: an "Assignment conditions" editor (its own
   ALL/ANY match mode, metafield picker scoped to `company_metafield`/`location_metafield`
   definitions, reusing the product builder's `MetafieldValue` component) and an
   "Assignment preview" section (locations sorted into would-be-added, already-assigned
   and doesn't-match, with a reason per row), following the same 500ms-debounced live
   preview pattern as product rules. New action intents `assignment-preview` and
   `assignment-save`, alongside the existing `preview`/`save`. Verified against the dev
   store fixtures: a `company_metafield` "Customer type is wholesale" condition correctly
   reported Powderbound as "already assigned" (it already has this catalog's context) and
   Snowdevil/Alpine VIP Outfitters as not matching; the saved rule persisted across a
   page reload.
4. ~~Apply~~: done and tested end to end on the dev store (Sep 2026), including a real
   `catalogContextUpdate` write (added Snowdevil to "Spike: Powderbound trade", confirmed
   via `listAssignmentLocations`, then removed again to restore the fixtures).
   `app/lib/assignment/apply.server.ts`: one `catalogContextUpdate` call with every
   matched, not-yet-assigned location's ID, `contextsToAdd` only (never
   `contextsToRemove`, per the additive-only decision). No chunking: unlike
   `publicationUpdate` (finding 1), `catalogContextUpdate` has no documented per-call
   limit, and company location counts are small. The action always re-evaluates the
   *saved* rules against a fresh location read (never trusts the client's rules or a
   stale preview) before applying. `write_products` added to `shopify.app.toml`; on this
   personal dev store the new scope was **auto-granted** on the next `npm run dev`
   restart, with no manual re-consent click needed (confirmed Sep 2026). A real
   merchant install would still need to reopen the app to approve it.
5. ~~Automatic re-scan~~: done and tested end to end on the dev store (Sep 2026). A new
   `assignment-scan` BullMQ queue (`app/lib/queue/queues.server.ts`), with a single
   repeating job (BullMQ's `upsertJobScheduler`, not a delayed `add`: v6 moved repeatable
   jobs to their own API) every 15 minutes, coarse for v1 since there's no event to key
   off. `app/lib/assignment/auto-scan.server.ts`'s `runAssignmentAutoScan` finds every
   catalog with a saved `ASSIGNMENT` rule set, grouped by shop, and re-evaluates each
   catalog against a fresh location read and applies any newly matching, not-yet-assigned
   locations, reusing `isUnassignedMatch` and `applyAssignments` from steps 3 and 4 so
   the automatic path can't diverge from the manual one. `listAssignmentLocations` is
   read once per shop and shared across that shop's catalogs, not once per catalog,
   since it's a shop-wide read regardless of which catalog asks. One BullMQ job runs the
   whole scan rather than one job per catalog (unlike `catalog-sync`): coarse for v1, so
   a catalog that keeps failing is only a logged error until the next sweep, not its own
   retryable job. `listAssignmentLocations` waits out the throttle bucket between pages
   the same way `sync/apply.server.ts` does for repeated writes, though every shop that
   can reach this code is on Plus (B2B catalogs are Plus-only, finding 11), so this is
   headroom for a shop with many locations rather than an everyday wait. Registered and
   scheduled by `app/worker.ts` on startup (`upsertJobScheduler` is idempotent, so
   restarting the worker doesn't duplicate the schedule). Verified by temporarily
   pointing a saved rule at Snowdevil and calling `runAssignmentAutoScan()` directly: it
   found the new match
   and added it via a real `catalogContextUpdate`, then the fixtures were restored.

Phase 2 is now complete.

## Planned features (not yet scheduled)

~~**Sidekick integration**~~: done and tested end to end on the dev store (Sep 2026), as
the rescoped v0 below (PR #10). Verified live via an actual Sidekick conversation:
asking "Do I have a catalog for wholesale customers?" correctly found "Spike:
Powderbound trade" with its real saved rule ("custom.customer_type is wholesale"),
rendered as a clickable link, which navigated to the right catalog's rule builder. No
other feature is currently queued; this section is kept for the platform-gap writeup
and to revisit the original create-from-prompt vision if Shopify ever adds a fitting
intent type (see the last bullet below).

**Sidekick integration** (idea from Dan, Sep 2026, rescoped Sep 2026 after checking the
current Sidekick app extensions docs in detail). Original goal: a merchant types a
prompt like "make a catalog for VIP users, company or location metafield of
custom_user_type = vip and products tagged vip" into Sidekick and gets a catalog built
from that. **That exact vision isn't buildable cleanly today**, so the plan below is a
scaled-down v0 Dan chose after seeing the platform gap, not the original ask.

Why the original "create from a prompt" vision doesn't fit: Sidekick can only invoke an
app extension via a registered **intent**, and every intent must declare a `type` from a
fixed, Shopify-maintained list (`application/ad`, `campaign`, `email`, `faq`,
`loyalty-program`, `quote`, `return`, `review`, `shipment`, `ticket`, or
`shopify/customer|order|product` for import-only). None fit "create a catalog from
include/exclude rules", and each type's `inputSchema` must `$ref` that type's own
Shopify-hosted schema, so it's not just a naming mismatch: the payload shape itself is
bound to the type. Forcing an unrelated type is explicitly discouraged ("Sidekick won't
reliably invoke your extension"). The only sanctioned route to a fitting type is
proposing one in Shopify's public app intent types repository, an external process with
no controllable timeline. Given a choice between waiting on that, forcing a bad type
match, or shipping a smaller thing that works today, Dan chose the last.

**v0 scope (read-only, no new intent needed)**: an `admin.app.tools.data` ("App tools")
extension, which lets Sidekick call read/search tools with no intent-type registration
at all. It can't get the polished "click to open" resource-link handoff (that handoff
specifically depends on a `resource_link`'s `mimeType` matching a registered intent
type, which we don't have), but a tool can return a plain description containing a
literal admin URL, which Sidekick's chat surface should still render as a clickable
link.

- Extension at `extensions/catalog-tools/` (CLI: `shopify app generate extension
  --template app_data`), target `admin.app.tools.data`. No API version bump needed:
  `2026-07` (already in use) supports this target.
- Two tools in `tools.json`:
  - `search_catalogs({ query, catalogType? })`: case-insensitive match against catalog
    titles and condition values/metafield keys across a catalog's `CATALOG` rule set
    (product membership) and, for `COMPANY_LOCATION` catalogs, its `ASSIGNMENT` rule set
    too. Returns top matches with a plain-English reason built from the condition data,
    plus an admin URL to that catalog's rule builder.
  - `describe_catalog_rules({ catalogTitle })`: explains what a named catalog's saved
    rules currently do.
- `instructions.md` must tell Sidekick these tools are read-only/informational: never
  imply anything was created or changed in Shopify.
- Two new authenticated routes (e.g. `api.sidekick.search-catalogs.tsx`,
  `api.sidekick.describe-catalog.tsx`) using the existing `authenticate.admin` pattern.
  **Corrected after live testing (Sep 2026):** the extension's call really is
  cross-origin (an earlier plan draft assumed it wasn't and that no CORS handling was
  needed; that was wrong). The browser sends a CORS preflight `OPTIONS` request before
  the real `POST`, and React Router only ever routes `OPTIONS` to a route's `loader`,
  never its `action`. A resource route with only an `action` makes that preflight fail
  outright (a router-level error, not even reaching our code), which aborts the real
  request before it's sent; to Sidekick that looks exactly like it can't reach the app
  at all ("connection issue"), with nothing useful in the app's own logs. The fix: add a
  `loader` that also calls `authenticate.admin(request)` (it replies to an `OPTIONS`
  request itself, via `respondToOptionsRequest`, with a 204 and the right
  `Access-Control-Allow-*` headers) and wrap every actual response in the `cors` helper
  `authenticate.admin` returns, e.g. `return cors(Response.json({ results }))`. No new
  Admin API scopes needed: everything the tools read (`Catalog`, `RuleSet`, `Condition`)
  is already in the app's own Postgres tables, no live Shopify GraphQL calls needed for
  the search itself.
  - Diagnostic gotcha: testing this route directly with `curl` can be misleading.
    `curl`'s default User-Agent gets flagged by the library's bot detection
    (`respondToBotRequest`, via `isbot`), which throws its own 410 *before*
    `respondToOptionsRequest` ever runs, giving a 410-with-CORS-headers response that
    looks like a real failure. Set a browser-like `User-Agent` header to see the actual
    204 a real browser would get.
- Add the required `[sidekick] extensions_summary` to `shopify.app.toml`.
- Open implementation detail: the clickable admin URL needs the app's handle (differs
  dev vs production) and the store handle derived from the shop domain; a small config
  item, not a blocker.
- Once this ships and is tested, revisit the original create-from-prompt vision only if
  Shopify adds a fitting intent type (or `app_data` tools gain write support).

## Pricing and billing (planned, not yet built)

No billing code exists in the app yet (confirmed Sep 2026: no `billing`/`Billing`
references anywhere). Researched ahead of the first App Store submission.

- **Use Shopify App Pricing**, not the Billing API: it's the default/recommended path for
  new public apps, configured in the Partner Dashboard (not in code), and Shopify hosts
  the plan page and handles trials, proration, upgrades and downgrades. The app only
  needs to check `activeSubscription` (Partner API) and gate access accordingly.
- **Flat tiered recurring plans**, not usage-based: this app's costs don't map to a
  natural per-unit merchant charge (unlike SMS/email apps), so tiers by feature/scale
  limit fit better than a usage meter. Draft structure (prices are a starting guess, not
  final):
  - **Free**: 1 managed Market catalog, manual sync only (no automatic webhook-triggered
    re-sync). Capping automatic sync on the free tier is deliberate: it's the main thing
    that drives worker/queue load, so it keeps free-tier hosting cost bounded.
  - **Growth (~$19-29/mo)**: unlimited Market catalogs, automatic sync, Sidekick search.
  - **Plus/B2B (~$49-79/mo)**: everything in Growth, plus B2B catalog assignment rules
    and the automatic assignment re-scan. This naturally only matters to Plus merchants
    anyway, since `CompanyLocationCatalog` is Plus-only (finding 11); no separate
    "price by Shopify plan" mechanism exists in Shopify App Pricing, so a Plus-gated
    *feature* tier is the way to get that effect.
  - Apply for Shopify's reduced revenue-share program: 0% on the first $1,000,000 USD
    lifetime app revenue, 15% after (down from the 20% default).
- **Dev stores are free automatically**: any Shopify App Pricing plan is $0 on a dev
  store in your own Partner org, no configuration needed. A dev store in a *different*
  Partner org (another developer, or a merchant trying it before going live) can only
  pick free plans by default; mark a specific paid plan "free to test" in the Partner
  Dashboard to let them try it too.
- **Rough unit economics** (Railway, Sep 2026 pricing, see the Railway section below for
  the underlying rates): fixed floor to keep the app running 24/7 (web + worker +
  Postgres + Redis, near-idle) is roughly $15-25/month. Marginal cost per shop is
  small and scales with activity (webhook volume, sync frequency, product index size,
  and for B2B the 15-minute assignment scan): rough order of magnitude $0.10-0.30/month
  for a quiet shop, up to $2-5/month for a large, active B2B one. At the draft prices
  above, gross margin (before Dan's own time) is roughly 95%+ per subscriber; the fixed
  floor is the only real risk while there are few paying merchants, and is covered by a
  single Growth subscriber. See "Hosting" below for the Railway rates this is based on.
- **Decided (Sep 2026): submit the first App Store version free-only.** No merchant
  will pay upfront for an unreviewed app, a free-only submission is a simpler review
  (no billing flow for Shopify to test), and the unit economics above mean staying free
  for a while costs very little even with a decent number of installs. Add Shopify App
  Pricing plans (Growth/Plus, with a free trial on each, e.g. 7 days) and the
  `activeSubscription` gate in a later update once there's a real install base and
  reviews; adding pricing later is a normal Shopify App Pricing update, not something
  the platform restricts to launch time. No billing code needed for the free-only
  submission itself.

## Hosting

**Railway project "smart-catalogs" is live (Sep 2026)**, on the Hobby plan ($5/month,
upgraded from the 30-day trial). Four services: `web` and `worker` (both from
`dandevuk/shopify-catalog-manager` via the existing `Dockerfile`), plus managed
`Postgres` and `Redis`. Confirmed pricing (railway.com/pricing): $20/month Pro plan
(includes $20 of usage credit), metered beyond that at roughly $20/vCPU-month,
$10/GB RAM-month, $0.15/GB disk-month, $0.05/GB egress; Postgres/Redis have no separate
pricing tier, they're billed as regular services on the same rates.

`web` env vars: `DATABASE_URL` and `REDIS_URL` as reference variables
(`${{Postgres.DATABASE_URL}}`, `${{Redis.REDIS_URL}}`), plus `SHOPIFY_API_KEY`,
`SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` (the generated Railway domain),
`SHOPIFY_APP_HANDLE`, `SCOPES`. `worker` needs the same minus `SHOPIFY_APP_HANDLE`/
`SCOPES` (unused there). Currently reusing the dev app's own client ID/secret to prove
the deploy works end to end; a real production app record and its own credentials are a
separate step before App Store submission.

Two real bugs found and fixed while setting this up, both worth knowing before touching
Railway (or any similar host) again:

- **A real secret leak in the Docker build**: `.dockerignore` didn't exclude `.env`, so
  `COPY . .` baked the real `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET` straight into the
  image layers. Fixed by adding `.env`, `.env.*` (keeping `!.env.example`), `.git` and
  `.shopify` to `.dockerignore`. Confirmed after the fix: `/app/.env` doesn't exist in
  the built image. This would have shipped the real secret to Railway's build layers on
  the very first deploy had it not been caught first.
- **Railway's Custom Start Command is not run through a shell**: setting it to
  `npm run setup && npx tsx app/worker.ts` deployed "successfully" every time (status
  `COMPLETED`, no error anywhere) but the worker was never actually running (`No running
  instances` in the Console tab) — `&&` and everything after it were passed as literal
  extra arguments to `npm run setup` (which silently accepted and ignored them), so the
  `npx tsx app/worker.ts` half never ran at all. No error, no crash, nothing in the
  logs to point at it: `npm run setup`'s own output (migrations etc.) looked completely
  normal and the deploy still reported success, because from Railway's point of view a
  process that runs and exits 0 *is* a successful deployment for a service with no
  exposed port to health-check against. The fix is to wrap the whole thing in an
  explicit shell: `sh -c "npm run setup && npx tsx app/worker.ts"`. Confirmed via the
  Console tab's `ps aux`: PID 1 is genuinely `npm exec tsx app/worker.ts`, staying
  resident. Diagnosed by temporarily appending `; sleep 3600` to keep the container
  alive long enough to inspect — a generally useful trick for debugging a "deploys fine
  but nothing's actually running" mystery on any host.
- Separately, the **web service's exposed port** needed correcting too: the Dockerfile
  `EXPOSE`s 3000, but `react-router-serve` actually binds to Railway's own auto-injected
  `PORT` env var (8080) when it's set, overriding that. The public domain's target port
  had to be set to 8080, not 3000, to stop a `502` on every request; confirmed via the
  deploy logs' own `[react-router-serve] http://localhost:8080` line.
- The web service's Dockerfile `CMD` (`prisma generate && prisma migrate deploy`, then
  `react-router-serve`) otherwise needed no changes, and running `prisma
  generate`/`migrate deploy` a second time from the worker's own start command is safe
  (Prisma's migrate is fine to run from two services on boot; the second run just logs
  "No pending migrations to apply").
- `shopify.app.toml`'s `application_url`/`redirect_urls` now point at the Railway
  domain, deployed (`shopify app deploy --allow-updates`) as a released app version;
  confirmed live by reopening the app fresh in the dev store admin. No separate
  "production app" record is needed: the same Partner Dashboard app entity (currently
  still using the dev app's own client ID/secret) just points at the real host instead
  of the dev tunnel. Moved off the Railway trial to the Hobby plan ($5/month).
- Not yet done: a custom domain (cosmetic, `up.railway.app` works for launch), and the
  pricing/billing gate decision (submit free-only first vs. build Shopify App Pricing
  plan gating now) from the Pricing and billing section above.

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
with no catalog context yet). Metafield definitions added for Phase 2 testing (Sep
2026): `custom.customer_type` on Company, `custom.region` on CompanyLocation. Values
set: Powderbound `wholesale`/`ca` (its location is genuinely US-market, so this is an
arbitrary test label, not a real region), Snowdevil `retail`/`us`. A third test company,
Alpine VIP Outfitters (created via the admin, no real contact), has `custom.customer_type
= vip` and no location metafield: matches the original Sidekick example prompt ("make a
catalog for VIP users..."). Its location has no catalog context either.

Gotcha confirmed while setting these up: the admin's own company/location pages show a
broader "Catalogs" list (e.g. Snowdevil shows "Catalog for Canada", Alpine VIP Outfitters
shows "Sync Test"/"Sync Test 2") than `CompanyLocation.catalogs` returns over the API
(empty for both). The admin display includes market-catalog eligibility; the GraphQL
field is scoped to actual `CompanyLocationCatalog` contexts (confirmed via
`listAssignmentLocations`), which is what `app/lib/assignment` needs and already uses.

## App Store listing

Draft listing copy (introduction, description, features, subtitle), the icon
generation prompt, and a privacy policy draft live in `app-store-listing.md` at the
repo root, along with the checklist of what's still needed (icon, screenshots, demo
video, emergency contact, etc.) before submission. Decided (Sep 2026): submit
free-only first (see "Pricing and billing" above), app card subtitle is "Rule-based
catalogs that stay in sync".

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
