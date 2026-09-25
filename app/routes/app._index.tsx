import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../lib/shop.server";
import {
  listCatalogs,
  type CatalogSummary,
} from "../lib/shopify/catalogs.server";
import {
  getProductIndexSummary,
  type ProductIndexSummary,
} from "../lib/product-index/index.server";
import { formatDateTime } from "../lib/format";
import { toCatalogParam } from "../lib/shopify/catalog-id";
import prisma from "../db.server";

/** Managed state per Shopify catalog ID, for the Rules column. */
type ManagedInfo = Record<
  string,
  { managed: boolean; lastSyncedAt: string | null }
>;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  await ensureShop(session.shop);

  const [result, productIndex, records] = await Promise.all([
    listCatalogs(admin),
    getProductIndexSummary(session.shop),
    prisma.catalog.findMany({
      where: { shop: { domain: session.shop } },
      select: { shopifyCatalogId: true, managed: true, lastSyncedAt: true },
    }),
  ]);
  const managed: ManagedInfo = Object.fromEntries(
    records.map((r) => [
      r.shopifyCatalogId,
      {
        managed: r.managed,
        lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
      },
    ]),
  );
  return {
    catalogs: result.catalogs,
    contextError: result.contextError,
    durationMs: result.durationMs,
    productIndex,
    managed,
  };
};

export default function CatalogsPage() {
  const { catalogs, contextError, durationMs, productIndex, managed } =
    useLoaderData<typeof loader>();

  const markets = catalogs.filter((catalog) => catalog.type === "MARKET");
  const b2b = catalogs.filter((catalog) => catalog.type === "COMPANY_LOCATION");

  return (
    <s-page heading="Catalogs">
      {contextError && (
        <s-banner
          tone="warning"
          heading="Market and company names couldn't be loaded"
        >
          <s-paragraph>
            The catalogs below are complete, but the app couldn&apos;t read
            which markets or company locations they belong to. This usually
            means an access scope is missing. Check the Diagnostics page for
            details.
          </s-paragraph>
          <s-paragraph>{contextError}</s-paragraph>
        </s-banner>
      )}

      <s-section heading="About this page">
        <s-paragraph>
          Every Market and B2B catalog in the store. A catalog with its own
          product list (a publication) doesn&apos;t receive new products
          automatically unless auto-publish is on, which is the problem Smart
          Catalogs solves. Sales channel catalogs are hidden.
        </s-paragraph>
      </s-section>

      <ProductIndexSection summary={productIndex} />

      <CatalogTable
        heading={`Market catalogs (${markets.length})`}
        catalogs={markets}
        managed={managed}
      />
      <CatalogTable
        heading={`B2B catalogs (${b2b.length})`}
        catalogs={b2b}
        managed={managed}
      />

      <s-section>
        <s-paragraph>Loaded from Shopify in {durationMs} ms.</s-paragraph>
      </s-section>
    </s-page>
  );
}

function CatalogTable({
  heading,
  catalogs,
  managed,
}: {
  heading: string;
  catalogs: CatalogSummary[];
  managed: ManagedInfo;
}) {
  const navigate = useNavigate();

  if (catalogs.length === 0) {
    return (
      <s-section heading={heading}>
        <s-paragraph>No catalogs of this type yet.</s-paragraph>
      </s-section>
    );
  }

  return (
    <s-section heading={heading} padding="none">
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Catalog</s-table-header>
          <s-table-header listSlot="secondary">Applies to</s-table-header>
          <s-table-header listSlot="inline">Status</s-table-header>
          <s-table-header format="numeric">Products</s-table-header>
          <s-table-header>New products</s-table-header>
          <s-table-header>Last admin change</s-table-header>
          <s-table-header>Rules</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {catalogs.map((catalog) => (
            <s-table-row key={catalog.id}>
              <s-table-cell>{catalog.title}</s-table-cell>
              <s-table-cell>{describeContexts(catalog)}</s-table-cell>
              <s-table-cell>
                <s-badge
                  tone={catalog.status === "ACTIVE" ? "success" : "info"}
                >
                  {titleCase(catalog.status)}
                </s-badge>
              </s-table-cell>
              <s-table-cell>{describeCount(catalog)}</s-table-cell>
              <s-table-cell>
                <NewProductsBadge catalog={catalog} />
              </s-table-cell>
              <s-table-cell>{describeOperation(catalog)}</s-table-cell>
              <s-table-cell>
                <s-stack direction="block" gap="small-200">
                  {managed[catalog.id]?.managed && (
                    <s-stack direction="inline" gap="small-200">
                      <s-badge tone="success">Managed</s-badge>
                      {managed[catalog.id]?.lastSyncedAt && (
                        <s-text>
                          Synced{" "}
                          {formatDateTime(managed[catalog.id]!.lastSyncedAt!)}
                        </s-text>
                      )}
                    </s-stack>
                  )}
                  <s-button
                    variant="tertiary"
                    onClick={() =>
                      navigate(`/app/catalogs/${toCatalogParam(catalog.id)}`)
                    }
                  >
                    {managed[catalog.id]?.managed
                      ? "Edit rules"
                      : "Set up rules"}
                  </s-button>
                </s-stack>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-section>
  );
}

function ProductIndexSection({ summary }: { summary: ProductIndexSummary }) {
  return (
    <s-section heading="Product index">
      <s-paragraph>
        {summary.productCount} products indexed.{" "}
        {summary.rebuiltAt
          ? `Last rebuilt ${formatDateTime(summary.rebuiltAt)}.`
          : "The index hasn't been built yet."}
        {summary.status === "RUNNING" ? " A rebuild is running." : ""}
      </s-paragraph>
      {summary.status === "FAILED" && (
        <s-banner tone="critical" heading="The last rebuild failed">
          <s-paragraph>{summary.error}</s-paragraph>
          <s-paragraph>Rebuild it from the Diagnostics page.</s-paragraph>
        </s-banner>
      )}
    </s-section>
  );
}

/**
 * Whether new products reach this catalog on their own:
 * - no publication: availability follows the sales channel, so yes
 * - publication with autoPublish on: yes
 * - publication with autoPublish off: no (spike finding 4)
 */
function NewProductsBadge({ catalog }: { catalog: CatalogSummary }) {
  if (!catalog.publicationId) {
    return <s-badge tone="info">Follows sales channel</s-badge>;
  }
  if (catalog.autoPublish) {
    return <s-badge tone="success">Added automatically</s-badge>;
  }
  return <s-badge tone="warning">Not added</s-badge>;
}

function describeContexts(catalog: CatalogSummary): string {
  if (catalog.contexts.length === 0) {
    return catalog.contextCount > 0
      ? `${catalog.contextCount} assigned`
      : "Not assigned";
  }
  const extra = catalog.contextCount - catalog.contexts.length;
  return extra > 0
    ? `${catalog.contexts.join(", ")} and ${extra} more`
    : catalog.contexts.join(", ");
}

function describeCount(catalog: CatalogSummary): string {
  if (!catalog.publicationId) return "All";
  if (catalog.productCount === null) return "Unknown";
  return catalog.productCountIsExact
    ? String(catalog.productCount)
    : `${catalog.productCount}+`;
}

function describeOperation(catalog: CatalogSummary): string {
  if (!catalog.latestOperation) return "None";
  const type = catalog.latestOperation.type.replace(/Operation$/, "");
  return `${type} (${titleCase(catalog.latestOperation.status)})`;
}

function titleCase(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
