# Shopify App Store listing — Smart Catalogs

Working copy for the Partner Dashboard submission form. Draft content, not yet
submitted; fill in bracketed placeholders and get the privacy policy reviewed before
publishing anything. See CLAUDE.md's "Pricing and billing" and "Hosting" sections for
the app's technical/business status.

## App card subtitle

Decided (Sep 2026):

> Rule-based catalogs that stay in sync

Alternatives considered, not used: "Automatic catalog rules for Market & B2B", "Smart
rules, always-synced catalogs", "Catalogs that update themselves".

## App introduction (100 char limit)

> Keep Market and B2B catalogs in sync automatically as products change — no manual
> updates needed.

## Full description

> Smart Catalogs adds smart-collection-style rules to your Market and B2B catalogs,
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

For an AI image generator (Midjourney/DALL-E/Firefly), 1200x1200px:

> A minimalist flat-design app icon, 1200x1200px, square canvas with softly rounded
> corners. Single centered focal shape: a stylized open folder or catalog/grid icon
> combined with a subtle circular arrow (sync/refresh) motif, suggesting
> "automatically organized and kept up to date." Bold, saturated two-tone color
> palette — deep indigo/purple background with a bright teal or lime-green accent
> shape, high contrast (4.5:1+), no gradients, no drop shadows, no text or letters
> anywhere in the image, no Shopify logo or bag icon, generous negative space around
> the central shape so it stays legible at 32px. Clean geometric vector illustration
> style, similar to modern SaaS app icons (Notion, Linear, Asana style), centered
> composition, solid flat background color filling the entire square.

Adjust the palette to taste; indigo/teal was just a suggestion.

## Privacy policy (draft — needs legal review before publishing)

---

**Privacy Policy — Smart Catalogs**

*Last updated: [DATE]*

Smart Catalogs ("the app") is provided by [YOUR BUSINESS NAME] ("we", "us"). This
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

- [ ] App icon (1200x1200 PNG/JPEG) — generate from the prompt above, or design manually
- [ ] Emergency developer contact (email + phone) in Partner Dashboard account settings
- [ ] API contact email (must not contain "Shopify")
- [ ] Confirm "Smart Catalogs" as the final app name; check it isn't already taken
- [ ] Host the privacy policy somewhere with a stable URL, after filling in placeholders
  and getting it reviewed
- [ ] Support URL / support email for the listing
- [ ] Demo screencast (2-3 min) showing onboarding and core features
- [ ] Screenshots (3-6 at 1600x900, 16:9) — rule builder, live preview, B2B assignment
- [ ] Demo store URL: a dev store link that showcases the app (Catalog Manager Test can
  likely serve this, or a dedicated clean demo store)
- [ ] Test credentials for the Shopify review team (if the app requires login beyond
  the standard OAuth install)
