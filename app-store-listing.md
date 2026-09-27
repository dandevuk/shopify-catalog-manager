# Shopify App Store listing — Catalogic

Working copy for the Partner Dashboard submission form. Draft content, not yet
submitted; fill in bracketed placeholders and get the privacy policy reviewed before
publishing anything. See CLAUDE.md's "Pricing and billing" and "Hosting" sections for
the app's technical/business status.

## App card subtitle

Decided (Sep 2026):

> Rule-based catalogs that stay in sync

Alternatives considered, not used: "Automatic catalog rules for Market & B2B", "Smart
rules, always-synced catalogs", "Catalogs that update themselves". Re-checked (Sep
2026) after the app name changed to "Catalogic": still reads well, doesn't reference
the old name, no change needed.

## App introduction (100 char limit)

Rewritten (Sep 2026) to lead with the actual gap (native Market/B2B catalogs have no
rule/condition support at all) rather than just the sync benefit:

> Add rule-based conditions to Market and B2B catalogs, so the right products show up
> automatically.

Previous draft, not used: "Keep Market and B2B catalogs in sync automatically as
products change — no manual updates needed." (all sync benefit, no mention of the
actual differentiator).

## Full description

> Catalogic adds smart-collection-style rules to your Market and B2B catalogs,
> then keeps them in sync automatically — no more products left out of a catalog
> because autoPublish is off.
>
> Build include/exclude rules from tags, vendor, product type, title, collection,
> category and metafields, and preview exactly what would change before anything is
> applied. Turn on automatic sync and new or updated products join the right catalogs
> on their own.
>
> For B2B stores on Shopify Plus, assign catalogs to company locations automatically
> too — for example, giving every location where a company's `customer_type` metafield
> is "wholesale" access to your Wholesale catalog, re-checked on a schedule as company
> data changes.
>
> Ask Shopify Sidekick which catalog matches a group of products or customers, and get
> a plain-English explanation of what each catalog's rules currently do.

## Key features list

- Rule-based catalogs built from tags, vendor, type, title, collection, category and
  metafields
- Live preview of exactly what would change before you apply anything
- Automatic sync — new and updated products join the right catalogs on their own
- B2B catalog assignment by company/location metafields, with automatic re-scanning
- Ask Sidekick to find or explain a catalog's rules in plain English

## App icon generation prompt

**Shopify's actual app icon spec** (confirmed from shopify.dev/docs/apps/design/visual-design,
Sep 2026), which supersedes the general "app icon" advice below:

- PNG or JPG, **square 1200x1200px**
- **No rounded corners** — Shopify applies its own corner mask on top, so submit a
  plain square; a pre-rounded icon risks looking double-rounded or bordered
- Icon content should fill **10/16 to 12/16 of the canvas** (750-900px of the 1200px
  square), with a **1/16 (75px) clear margin** on all sides with no visual elements
- Icons render **on white/light-gray backgrounds** in the Shopify admin (left nav,
  Apps page), so avoid pale colors or a background tone that vanishes against white
- Avoid excessive text; don't use any part of the Shopify logo

Chosen concept (Sep 2026): a product grid with one tile picked out, showing "a rule
selects specific items from a catalog" rather than the sync/folder idea originally
drafted. For an AI image generator (Midjourney/DALL-E/Firefly):

> A minimalist flat-design app icon, exactly 1200x1200px, plain square canvas with
> **sharp, unrounded corners** (Shopify applies its own corner mask, so the corners
> must be square, not pre-rounded). Fill only the central 750-900px with the design,
> leaving at least a 75px clear margin on all sides. Single focal shape: a 3x3 grid of
> small rounded squares representing a product catalog, with exactly one square
> highlighted in a contrasting accent color to show a rule selecting it from the
> group. Solid background color (not white or pale, since the icon will sit on a
> white/light-grey admin background), bold two-tone palette, high contrast (4.5:1+),
> no gradients, no drop shadows, no text or letters anywhere, no Shopify logo or bag
> icon. Clean flat geometric vector illustration style, similar to modern SaaS app
> icons (Notion, Linear, Asana), centered composition.

Four draft variants were generated and reviewed (Sep 2026); all were made with rounded
corners and need regenerating/cropping to a sharp-cornered square before submission.
The grid-with-one-highlighted-tile concept (originally shown with two highlighted
tiles, navy background, yellow/teal squares) was picked as the clearest fit: legible at
favicon size, and about "rules select items from a catalog" rather than an unrelated
metaphor (funnel, checklist, sync-arrow). A single-tile final version (navy background
flush to the edges, one teal tile with a white checkmark) was generated; see the
checklist below for upload status. Re-checked (Sep 2026) after the app name changed to
"Catalogic": the "a rule picks this one out of the catalog" concept still fits fine,
no change needed.

## Privacy policy (draft — needs legal review before publishing)

---

**Privacy Policy — Catalogic**

*Last updated: [DATE]*

Catalogic ("the app") is provided by [YOUR BUSINESS NAME] ("we", "us"). This
policy explains what data we collect when you install the app on your Shopify store,
and how we use it.

**What we collect**

- **Store information**: your store's domain, plan, and installation status.
- **Product data**: titles, tags, vendor, product type, status, category, collection
  membership, and metafield values, indexed from your store's catalog so the app can
  evaluate your saved rules.
- **Catalog rules**: the include/exclude conditions you configure for each Market or
  B2B catalog.
- **Company and location metafields** (B2B merchants only, Shopify Plus): used solely
  to evaluate automatic catalog assignment rules you configure. We do not access
  customer names, contact details, or any other customer data.
- **Sync history**: a log of changes the app has made to your catalogs, kept so you can
  review what happened and when.

**What we don't collect**

We deliberately do not request access to, or store, customer personal data (names,
emails, addresses, order history) or payment information. The app's B2B features work
only with company- and location-level business metadata.

**How we use this data**

Solely to provide the app's functionality: evaluating your saved rules against your
product catalog, keeping Market and B2B catalogs in sync, and showing you a preview of
changes before they're applied. We don't sell, rent, or share your data with third
parties, and we don't use it for advertising.

**Data retention and deletion**

If you uninstall the app, we stop syncing your catalogs. Your data is deleted from our
systems in accordance with Shopify's data protection requirements, including in
response to `customers/redact` and `shop/redact` webhooks. You can request deletion of
your data at any time by contacting us at [SUPPORT EMAIL].

**Third parties**

The app runs on Railway (hosting) and does not share your store's data with any other
third party.

**Changes to this policy**

We'll update this page if our data practices change, and update the "last updated" date
above.

**Contact**

Questions about this policy or your data: [SUPPORT EMAIL].

---

## Still needed (not yet done)

- [x] Distribution method: **Public distribution** selected in the Partner Dashboard
  (Sep 2026) — irreversible, done deliberately.
- [x] API contact email already set: `dan@danhall.uk` (doesn't contain "Shopify", no
  change needed)
- [x] Live automated checks (Partner Dashboard → Manage submission → "Automated checks
  for common errors" → Run): **all passed** (Sep 2026) — immediately authenticates
  after install, immediately redirects to app UI after auth, provides the mandatory
  compliance webhooks, verifies webhook HMAC signatures, and uses a valid TLS
  certificate. This closes out both "needs review" items from the codebase-only
  compliance check (TLS cert validity and the OAuth/redirect flow), which couldn't be
  confirmed from source code alone. Note: these checks expire after 30 days, so
  re-run them again close to actually submitting if it's been a while.
- [ ] App icon: **design finalized** (Sep 2026) — 1200x1200, navy background flush to
  the edges (no rounded corners), 3x3 grid of yellow rounded tiles with one teal tile
  and a white checkmark ("a rule picks this one out of the catalog"). Still needs
  uploading at Dev Dashboard → app → App settings → App icon (not yet confirmed done).
- [x] Emergency developer contact added in Partner Dashboard account settings (Sep
  2026, per the submission checklist)
- [x] App name: **"Catalogic"** decided (Sep 2026). History: "Smart Catalogs" was
  the working name throughout development, but turned out to be an exact match for
  an existing unrelated app (a PDF-catalog generator, 5.0★/1 review) on the Shopify
  App Store, so it's not available. "Catalog Rules" was considered next (states the
  mechanism plainly, avoids the crowded/irrelevant "catalog manager" PIM/dropship
  keyword space) but collides with an established, Shopify Build Awards-mentioned
  competitor, "Catalog Rules: B2B Pricing", in the same B2B catalog space. "Catalogic"
  was checked live against the App Store (Sep 2026, Google site-search of
  apps.shopify.com) and found clear, along with four other clear alternatives
  (Rulebound, Cataloft, Sortlogic, Assortist) kept as backups if this one runs into
  trouble at actual submission time. Renamed across `shopify.app.toml`, this file, the
  Sidekick extension (`tools.json`, `instructions.md`, `locales/en.default.json`), the
  public landing page, and project docs (Sep 2026).
- [ ] Host the privacy policy somewhere with a stable URL, after filling in placeholders
  and getting it reviewed
- [ ] Support URL / support email for the listing
- [ ] Screenshots (3-6 at 1600x900, 16:9) — rule builder, live preview, B2B assignment
- [ ] **Demo store URL** (the public listing field, shown to merchants browsing the
  App Store before they install): confirmed from shopify.dev's best-practices page
  (Sep 2026) this field is meant for a page an anonymous visitor can see that
  demonstrates the app's effect. Catalogic has no storefront-facing component at
  all (everything lives in the Shopify admin behind login), so there's no page to
  send an anonymous visitor to. Common/accepted practice for admin-only apps: point
  this at the demo store's storefront homepage and lean on screenshots and the feature
  video instead. Not a gap worth forcing a fix for.
- [ ] **App review preparation** (a separate field, for Shopify's actual review team,
  not browsing merchants): a screencast (2-3 min, promotional not just instructional)
  showing the real setup and core flows (rule builder, live preview, managed
  mode/"Apply to Shopify", B2B assignment), plus written test instructions and, if
  needed, test credentials so reviewers can install and try it themselves (e.g. on
  "Catalog Manager Test" or a store designated for review). This is the one that
  actually matters functionally, unlike the Demo store URL above.

## Built for Shopify (future goal, not a launch blocker)

Can't be pursued until the app is already live with real traction — the "Apply now"
button in Partner Dashboard → Distribution only unlocks once these are met:

- Minimum 50 net installs from active shops on **paid Shopify plans** (about the
  merchant's own Shopify plan, not our app's pricing; dev/trial stores don't count)
- Minimum 5 reviews
- A minimum app rating threshold
- Good Partner Program standing, no active infractions

Revisit once those are hit. Other standards (Core Web Vitals performance, session/token
security, accessibility, "look and behave like part of the admin," localization,
POS/mobile support) are worth keeping in mind as ongoing quality bars, but don't block
submission now.

## Navigation notes

- **Dev Dashboard** (dev.shopify.com) handles technical config: app settings, icon
  upload, contact email, versions/deploys. This is what `shopify app deploy` targets.
- **Partner Dashboard** (partners.shopify.com/<org-id>/apps/<client-id>/...) still
  handles **Distribution** and the App Store **listing** itself (name, subtitle,
  description, screenshots, pricing, Built for Shopify), even for orgs that have moved
  to the Dev Dashboard for everything else. Reach it from the Dev Dashboard app
  Overview page's "Distribution" card.
