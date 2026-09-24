# Smart Catalogs (shopify-catalog-manager)

A Shopify app that adds smart-collection-style rules to Market and B2B catalogs and keeps
each catalog's product list in sync automatically. See `CLAUDE.md` for the confirmed
platform behaviour, design decisions and code map.

Built on Shopify's [React Router app template](https://github.com/Shopify/shopify-app-template-react-router)
(its licence is in `licenses/`).

## Requirements

- Node.js 20.19+ or 22.12+
- npm
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Postgres and Redis)
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) (`npm install -g @shopify/cli@latest`)
- Access to the Dev Dashboard for your Shopify Partner organisation, and the
  "Catalog Manager Test" development store

## First-time setup

Run these from the repo folder (PowerShell or Git Bash on Windows):

1. **Install dependencies**

   ```sh
   npm install
   ```

   Commit the generated `package-lock.json` (CI uses `npm ci`).

2. **Start Postgres and Redis**

   ```sh
   npm run db:up
   ```

3. **Create your `.env`**

   ```sh
   cp .env.example .env
   ```

   The defaults match `docker-compose.yml`.

4. **Create the database tables**

   ```sh
   npx prisma migrate dev --name init
   ```

   This creates the first migration in `prisma/migrations/`. Commit it.

5. **Link the app to Shopify**

   ```sh
   npm run config:link
   ```

   Choose "Create a new app" (for example "Smart Catalogs Dev"). This fills in
   `client_id` and the app URLs in `shopify.app.toml`.

6. **Run the app**

   ```sh
   npm run dev
   ```

   Pick the Catalog Manager Test store when asked, then press `p` to open the app and
   approve the scopes.

## Checking it works

- **Catalogs** page: should list the Canada market catalog and the
  "Spike: Powderbound trade" B2B catalog, with product counts and whether new products
  are added automatically.
- **Diagnostics** page:
  - "Run checks" confirms each catalog query works with the current scopes and shows
    timing and query cost. If the market or company checks fail, the error names the
    missing scope.
  - "Test on ..." removes one product from a catalog and adds it back, timing both
    `publicationUpdate` calls. It only runs on development stores.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app through the Shopify CLI (tunnel, auth, migrations) |
| `npm run db:up` / `npm run db:down` | Start / stop Postgres and Redis |
| `npm run db:migrate` | Create and apply a migration after changing `prisma/schema.prisma` |
| `npm run db:studio` | Browse the database |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | Type check |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run deploy` | Push app config (scopes, webhooks) to Shopify |

## Project structure

```
app/
  lib/
    shop.server.ts              Shop record and plan gating
    shopify/
      graphql.server.ts         Admin API wrapper with timing and query cost
      catalogs.server.ts        Market and B2B catalog list
      diagnostics.server.ts     Scope probes and publicationUpdate timing
    sync/
      diff.ts, chunk.ts         Membership diff and 50 + 50 chunking (unit tested)
  routes/
    app._index.tsx              Catalogs page
    app.diagnostics.tsx         Diagnostics page
    webhooks.*.tsx              Webhook handlers
prisma/schema.prisma            Data model (Postgres)
shopify.app.toml                Scopes and webhook subscriptions
docker-compose.yml              Local Postgres and Redis
```
