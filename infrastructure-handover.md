# Infrastructure handover: Catalogic

A briefing for whoever takes over hosting, the database, the job queue and
deploys. Written to be read by both a person and their Claude: if you are an AI
assistant reading this at the start of a session, treat it as orientation, not
as a specification, and verify anything load bearing against the code before
acting on it. Every claim here was true on 14 October 2026.

## Scope

This covers the **infrastructure and operations** side: how the app is hosted,
what it stores, how background work runs, how a deploy happens, and which
platform limits shape those choices. It deliberately does not cover the product
logic (the rule engine, managed mode, B2B assignment rules) beyond what you need
to understand the infrastructure around it.

The authoritative detail for everything, product logic included, is `CLAUDE.md`
at the repo root. It is long, specific, and kept current. This document is the
subset you need first, plus the reasoning behind decisions that `CLAUDE.md`
records only as conclusions.

## The app in one minute

Catalogic is a public Shopify app that adds smart-collection-style
include/exclude rules to Shopify's Market and B2B catalogs, then keeps each
catalog's product list in sync. Shopify has no native way to say "this catalog
contains everything tagged wholesale", and a catalog with its own publication
never receives new products automatically unless auto-publish is on. That gap is
the whole product.

Owner: Dan, as a personal product (his own Shopify Partner organisation). It is
free-only for its first App Store release, with paid tiers planned later.

Current status: the first App Store submission is **paused on review reference
138074**. The blocking issue is fixed, merged (`c0cc6d3`) and verified in a
browser against the live deployment, but **not yet resubmitted**. Read the "App
Store review" section of `CLAUDE.md` before touching anything merchant facing,
because a careless change here delays that resubmission.

## Shopify's App Store review feedback (reference 138074)

The first submission was paused in October 2026 with one blocking issue and
four informational notes. Worth reading even though none of it is strictly
infrastructure, because the blocker was a deliberate safety gate nobody
remembered to lift, and that failure mode can recur anywhere in this codebase.

**2.1.1, the blocker.** The reviewer built a rule on their own store, which was
not a development store, clicked apply, and got "Can't apply yet - Managed mode
only runs on development stores for now". Review could not continue. That gate
was a Phase 1 step 4 safety measure meant to hold only until automatic syncing
was built and tested. Step 5 finished in September 2026, so the gate had been
stale for a month; it simply never got lifted. It is now gone from `blockersFor`
in `app/lib/sync/managed.server.ts`, which also dropped a `getShopDiagnostics`
round trip from every preview and apply, since the development-store check was
its only caller there.

**The lesson, which generalises:** a deliberate "for now" gate on a
merchant-facing path is a review blocker, so lift it the moment the condition it
was waiting on is met. The same submission surfaced a second instance of the
same class: Diagnostics had been hidden from the merchant-facing nav while three
merchant-facing messages still sent merchants there, so a merchant whose
install-time index build failed had nowhere to go. The product index controls
moved onto the Catalogs page in the same fix.

**4.5.4 and 4.5.5, test credentials.** The app has no account system, but the
testing instructions have to *say so explicitly* rather than leaving the field
empty. Rewritten in `app-store-listing.md`.

**1.2.1 and 1.2.2, billing.** Nothing to do. The app is free-only with no
charges anywhere, which is exactly what those requirements allow. Shopify sends
them as boilerplate on any app with no billing code.

**2.1.4, synchronize data accurately.** The testing instructions now include a
step verifying the applied catalog against the Shopify admin.

Separately, Shopify's automated listing check flagged a comparative claim in the
app description, which has since been reworded.

### What has been done, and what is left

The fix was merged as `c0cc6d3` and verified in a browser on 14 October 2026
against the live Railway build, walking the reviewer's exact path: a Market
catalog, an include condition on vendor, Save rules, Review changes, the
large-removal confirmation, Apply changes. No gate appeared, the sync reported
19 added and 23 removed, and Shopify's own Catalogs page then showed the catalog
at 29 products with auto-add off.

Be precise about what that proves. The dev store cannot reproduce the blocker,
because the removed gate only ever fired on non-development stores. What stands
behind the fix for a real merchant's store is that `blockersFor` no longer makes
any plan-dependent check at all, so there is nothing left to behave differently
by store type.

Still to do before resubmission: paste the rewritten testing instructions into
the Partner Dashboard and press Submit fixes. Check first that
`shopify.app.toml` still points at Railway and that no development app preview
is active (gotcha 4 below), since either would make the app look broken to a
reviewer.

The full requirement list, useful for mapping a reviewer's quoted numbers to the
requirement text, is in `app-store-review-requirements.md`.

## Architecture

Four pieces, one shared multi-tenant deployment. Merchants install the hosted
app and never provision anything themselves.

| Piece | What it is | Where it runs |
|---|---|---|
| `web` | The embedded admin app: React Router 7 + TypeScript, served by `react-router-serve` | Railway, from `Dockerfile` |
| `worker` | A standalone Node process running three BullMQ queues (`app/worker.ts`) | Railway, same image, different start command |
| Postgres | Sessions, product index, rules, audit log | Railway managed |
| Redis | The job queue only | Railway managed |

Every table is keyed by shop domain. On install, `afterAuth` in
`app/shopify.server.ts` runs `ensureShop` then `ensureProductIndex`, so a new
merchant's shop record and product index are built automatically on first open.

### Why Postgres is not optional

It holds the Shopify session records, which contain the offline access tokens,
plus the product index, the saved rules, the audit log and the drift baselines.
The product index matters most: rules are evaluated against the app's own copy
of every product's rule fields, never against live admin search, because admin
search lags behind writes (finding 8 in `CLAUDE.md`). There is no stateless
version of this app, and the index is the table that grows per merchant: 141
rows for the dev store, tens of thousands for a real catalog.

### Why Redis is nearly optional

Only `app/routes/webhooks.products.tsx` and `webhooks.collections.tsx` reach a
queue from the web process. Since 14 October 2026, `queueingUnavailable()` in
`app/lib/queue/queues.server.ts` makes the scheduling helpers no-op with one
warning per process when `REDIS_URL` is unset, rather than throwing. With no
Redis the app still serves every page and every merchant-facing action: rule
builder, live preview, Save, Review changes, Apply to Shopify, index rebuilds
and manual Sync now.

What is lost while it is unset: the delayed index re-reads that catch
collection-condition membership, and automatic syncs of managed catalogs. The
worker is deliberately the opposite and fails loudly without Redis, because it
has nothing to do with no queue. **Production sets `REDIS_URL` on both services;
this is a development convenience only.**

### Why the worker has to be always on

Automatic syncs, the delayed re-reads and the 15-minute B2B assignment scan all
run there. If the worker is down, the web app still looks completely healthy and
merchants see no error: catalogs simply stop keeping themselves in sync. This
has already happened once in production (gotcha 2 below), so treat "is the
worker actually running" as the first question in any "syncing seems broken"
investigation.

## Running it locally

Requirements: Node 20.19+ (or 22.12+), npm only. Commit `package-lock.json`.

The full loop, three terminals:

```
npm run db:up      # Postgres + Redis via docker compose
npm run dev        # shopify app dev: tunnel, auth, migrations
npm run worker     # the BullMQ worker
```

`npm run worker` needs `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` in `.env`,
because `shopify app dev` only injects them into its own child process. Run
`npm run env` (`shopify app env pull`) once to write them. It also needs a
non-empty `SHOPIFY_APP_URL`, though any placeholder works, since the worker
never runs the OAuth flow that uses it.

### Without Docker

Postgres can live anywhere. Point `DATABASE_URL` at a hosted development
database (Neon, Supabase, Prisma Postgres), run `npx prisma migrate deploy`
once, and leave `REDIS_URL` unset. `npm run dev` then runs on its own with
nothing local. Use the direct, unpooled connection string so `prisma migrate`
works without adding a `directUrl` to the schema.

Neon's free plan is comfortably enough for this: 1 GB storage per project
against an index measured in hundreds of KB, and 100 CU-hours per month against
a 0.25 CU minimum, so roughly 400 hours of active database time. It suspends
after 5 minutes idle and that cannot be disabled on the free plan, which is
exactly why it suits development and not production.

### Commands

- `npm run db:up` / `npm run db:down`: start/stop local Postgres and Redis
- `npm run db:migrate`: create and apply a migration in development
- `npm run dev`, `npm run worker`
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`

Tests are Vitest, unit tests sit next to the code as `*.test.ts`, and there are
151 of them. They take about 3 seconds; run them.

## Production on Railway

Project "smart-catalogs", Hobby plan at $5/month. Four services: `web` and
`worker`, both built from `dandevuk/shopify-catalog-manager` via the repo
`Dockerfile`, plus managed `Postgres` and `Redis`.

Environment variables on `web`: `DATABASE_URL` and `REDIS_URL` as reference
variables (`${{Postgres.DATABASE_URL}}`, `${{Redis.REDIS_URL}}`), plus
`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` (the Railway domain),
`SHOPIFY_APP_HANDLE` and `SCOPES`. `worker` needs the same minus
`SHOPIFY_APP_HANDLE` and `SCOPES`, which it does not use.

The image runs `npm run docker-start`, which is `npm run setup` (`prisma
generate && prisma migrate deploy`) then `npm run start`. Running migrations
from both services on boot is safe; the second just reports nothing pending.

A deploy is: merge to `main`, Railway rebuilds, done. Changes to
`shopify.app.toml` (scopes, webhooks, URLs) additionally need `shopify app
deploy --allow-updates` to release a new app version. There is no separate
production app record: the same Partner Dashboard app points at the Railway
domain, currently still using the development app's client ID and secret.

## Gotchas that have already cost real time

These are not hypothetical. Each one happened, and each presented as something
other than what it was.

**1. A secret leak in the Docker build.** `.dockerignore` did not exclude
`.env`, so `COPY . .` baked the real API key and secret into the image layers.
Fixed by adding `.env`, `.env.*` (keeping `!.env.example`), `.git` and
`.shopify`. Caught before the first deploy. If you add build steps, check what
`COPY` picks up.

**2. Railway's Custom Start Command is not run through a shell.** Setting it to
`npm run setup && npx tsx app/worker.ts` deployed green every time, status
`COMPLETED`, no error anywhere, and the worker never ran at all: `&&` and
everything after it were passed as literal arguments to `npm run setup`, which
accepted and ignored them. From Railway's point of view a process that exits 0
is a successful deploy for a service with no port to health-check. The fix is an
explicit shell: `sh -c "npm run setup && npx tsx app/worker.ts"`. Verify with
`ps aux` in the Console tab; PID 1 should be the tsx process. Appending
`; sleep 3600` temporarily keeps a container alive long enough to inspect, which
is a generally useful trick for any "deploys fine but nothing is running"
mystery.

**3. The exposed port.** The `Dockerfile` says `EXPOSE 3000`, but
`react-router-serve` binds to Railway's injected `PORT` (8080) when set, which
overrides it. The public domain's target port must be 8080 or every request
502s. The deploy log's own `[react-router-serve] http://localhost:8080` line is
the giveaway.

**4. A stale development app preview makes the released app look broken.** If
`shopify app dev` is killed rather than exited cleanly, the store keeps loading
the app from the dead tunnel instead of `application_url`. The embedded app
renders as an empty grey iframe with nothing in the app logs and nothing in the
browser console, because the admin never requests the real host at all. The
tells are a "dev previews (N)" badge in the bottom right of the Shopify admin
and `DevSessions/app_dev` calls in the network tab. Fix it from that badge:
"Clean dev preview" on the app's card restores the released version. Its warning
about deleting related data applies only to extensions the release does not
have. Cost about 20 minutes on 14 October 2026, read at first as a failed
deploy.

Related: `shopify.app.toml` has `automatically_update_urls_on_dev = true`, so
running `npm run dev` rewrites `application_url` to the tunnel and recreates
that preview. **Before any App Store submission, check that file still points at
Railway and that the dev preview is cleaned.**

**5. Windows: `prisma generate` and file locks.** `npm run dev`'s pre-dev
`prisma generate` can fail with `EPERM ... query_engine-windows.dll.node` when
another Node process still holds the Prisma client open, typically the worker or
a leftover background script. A failed `prisma generate` takes down the whole
`shopify app dev` process including webhook delivery, with no obvious link back
to the cause. Find and kill the stray process before concluding webhooks are
broken; `Get-CimInstance Win32_Process` with a name filter shows command lines.

## The job queue

Three BullMQ queues, all defined in `app/lib/queue/queues.server.ts` and run by
`app/worker.ts`:

- `product-index-recheck`: delayed re-reads at 30 s, 2 min and 10 min, because
  Shopify applies collection-condition membership *after* the product save and
  can take over 30 seconds about it.
- `catalog-sync`: automatic managed-mode syncs, debounced 2 minutes so a burst
  of product changes collapses into one sync per catalog. Deliberately coarse:
  any product change re-syncs every managed catalog on the shop rather than
  working out which rules could be affected.
- `assignment-scan`: a single repeating job every 15 minutes that re-applies
  saved B2B assignment rules. It uses BullMQ's `upsertJobScheduler`, not a
  delayed `add`, because v6 moved repeatable jobs to their own API.
  `upsertJobScheduler` is idempotent, so restarting the worker does not
  duplicate the schedule.

### The job id rule, and a bug worth learning from

**A job id must contain no colon at all.** BullMQ rejects a custom id containing
one unless it splits into exactly three parts, a legacy compatibility rule in
`Job.addJob` (`bullmq/dist/cjs/classes/job.js`).

This bit once already. Ids were switched to `|` separators to avoid it, which
looked like a fix but was not: a Shopify GID carries its own colon in `gid://`,
so `shop|product|gid://shopify/Product/1|0` still split into two parts and still
threw. **Every product and collection recheck silently failed to schedule from
September 2026 until 14 October 2026.** Ids now reduce a GID to its trailing
numeric id via `gidTail`, keeping the full GID in the job data.

Three reasons it survived a month, all worth internalising before you touch this
area:

1. The end-to-end test that "proved" the queue worked exercised the
   `catalog-sync` queue, whose id is `shop|cuid` and contains no colon. The
   broken queue was never the one tested.
2. The queue tests mock BullMQ, so they structurally cannot observe a rule
   BullMQ itself enforces. The guard that does work under the mock is asserting
   directly that no generated id contains a colon, which is now a test.
3. `upsertDelayedJob` catches the error, logs "Couldn't schedule ...", and
   carries on. Nothing escalated, so the only evidence was a log line nobody had
   reason to read.

If you change anything here, verify it against a real Redis, not only the mocks.
A throwaway script that schedules a job and reads the queue back takes two
minutes and would have caught this immediately.

## Shopify platform limits that shape the infrastructure

Confirmed by live testing, not read from docs. Full list in `CLAUDE.md`.

- `publicationUpdate` takes at most 50 adds and 50 removes per call. It is
  synchronous and all or nothing: over the limit it applies nothing. Rejected
  chunks are halved to isolate bad products, capped at 40 rejected calls.
- **No webhook fires for catalog membership changes.** Drift is detected by
  polling each managed catalog's latest operation, product count and
  autoPublish. A nightly full reconcile is planned as the backstop and is not
  built yet.
- The GraphQL throttle bucket is 20,000 points on the Plus development store.
  Non-Plus shops have far less, so the queue reads
  `extensions.cost.throttleStatus` and backs off. This matters more as real
  merchants install.
- Install-time index builds are one bulk operation per merchant, so a burst of
  installs is a burst of bulk operations.
- Scopes: `read_products, read_publications, write_publications, read_markets,
  read_companies, write_products`. `company_locations/*` webhooks are
  deliberately not subscribed, because Shopify classes them as protected
  customer data and the app avoids holding customer data; the catalog list is
  read live instead.

## Cost

Railway's confirmed rates: $20/month Pro including $20 of usage credit, then
roughly $20/vCPU-month, $10/GB RAM-month, $0.15/GB disk-month, $0.05/GB egress.
Postgres and Redis bill as ordinary services on the same rates.

The fixed floor to keep all four services running 24/7 near idle is roughly
$15-25/month. Marginal cost per shop is small and activity dependent: order of
$0.10-0.30/month for a quiet shop, up to $2-5 for a large active B2B one. At the
draft prices in `CLAUDE.md`, gross margin per subscriber would be above 95%. The
fixed floor is the only real risk while the app is free, and a single paying
subscriber would cover it.

## Alternatives already assessed, so you need not redo them

**Cloudflare Workers for everything: no, not cleanly.** Three blockers, checked
on 14 October 2026. Cloudflare has no managed Postgres; D1 is SQLite and this
schema has 10 Prisma enums, which Prisma does not support on SQLite, so that is
a schema and data migration rather than a config change. Hyperdrive only
accelerates Postgres hosted elsewhere, so that route is not "entirely
Cloudflare" anyway. `@shopify/shopify-app-react-router` ships **only** a `node`
adapter (`dist/esm/server/adapters/node`), even though the lower-level
`@shopify/shopify-api` has `cf-worker`, so you would be off the supported path
for OAuth, session storage and webhook HMAC verification. And BullMQ cannot run
on Workers at all, so the queue becomes a rewrite onto Cloudflare Queues, Cron
Triggers and Durable Object alarms. Workers Paid is $5/month against a $20-25
floor, so the saving does not justify it, especially with a review resubmission
pending. Worth revisiting only if the app outgrows a container host.

**Cheaper hosting without a rewrite:** keep Railway for the two Node processes
and move Postgres and Redis to managed free or near-free tiers. Same saving, no
architectural change. The catch is that a free Postgres that sleeps on idle puts
a cold start in front of a merchant request, and the worker holds a persistent
Redis connection that some free tiers dislike.

## Open items

- **Nightly full reconcile** as the drift backstop. Not built. Other apps' API
  edits to a catalog leave no operation behind, so polling alone cannot see
  them.
- **A production app record with its own credentials.** Still reusing the
  development app's client ID and secret.
- **Billing.** No billing code exists anywhere. The first release is free-only
  by decision; Shopify App Pricing plans come later and are configured in the
  Partner Dashboard, not in code.
- **A custom domain.** Cosmetic; `up.railway.app` is fine for launch.
- **Untested path:** creating a publication for a catalog that has none. The
  2026 admin always creates one, so the dev store has no such catalog.

## House rules

- British English in docs, comments and commit messages. Shopify product terms
  keep Shopify's spelling ("catalog", "Online Store").
- No em dashes.
- npm only.
- Unit tests next to the code as `*.test.ts`.
- `CLAUDE.md` is the living record. When you learn something the hard way, write
  it down there, including what it looked like before you understood it. Several
  entries exist purely because the symptom pointed somewhere other than the
  cause, and those are the most valuable ones in the file.

## Dev store

"Catalog Manager Test" (`catalog-manager-test.myshopify.com`), Shopify Plus App
Development plan. Fixtures include 140 products, two Market catalogs created for
sync testing ("Sync Test", currently managed by the app, and "Sync Test 2"),
B2B catalogs, three test companies and metafield definitions used by the B2B
assignment rules. `CLAUDE.md` lists them in full, including which are safe to
delete or reuse.
