# Sidekick app data extension

Read-only Sidekick tools for Smart Catalogs (`admin.app.tools.data` target).
See CLAUDE.md's "Planned features" section for the full scope and design
notes.

- `search_catalogs`: finds catalogs whose saved rules match a described group
  of products or customers.
- `describe_catalog_rules`: explains what a named catalog's saved rules do.

Both tools call the app's backend (`app/routes/api.sidekick.*.tsx`) via an
authenticated fetch from `src/index.js`; the actual matching logic lives in
`app/lib/sidekick/search.ts` (pure, unit tested) and `search.server.ts` (the
Prisma read).

### Testing locally

Run `shopify app dev` and open the "admin.app.tools.data" preview link in the
Dev Console to exercise the tools directly, or ask Sidekick a matching
question in the connected dev store's admin.

Learn more: [Sidekick app data extensions](https://shopify.dev/docs/apps/build/sidekick/build-app-data).
