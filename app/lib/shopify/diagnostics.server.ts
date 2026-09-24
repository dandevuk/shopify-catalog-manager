import {
  GraphqlRequestError,
  describeError,
  runGraphql,
  type AdminGraphqlClient,
  type QueryCost,
} from "./graphql.server";

/**
 * Spike test 8: confirm the minimum scopes, and measure latency and query cost
 * with a real app token (the spike itself ran through a different client).
 */

export interface ProbeResult {
  key: string;
  label: string;
  /** What passing this probe tells us */
  purpose: string;
  ok: boolean;
  durationMs: number;
  cost: QueryCost | null;
  error: string | null;
}

interface Probe {
  key: string;
  label: string;
  purpose: string;
  query: string;
  variables?: Record<string, unknown>;
}

const PROBES: Probe[] = [
  {
    key: "catalogs",
    label: "List catalogs with publication, count and latest operation",
    purpose: "Core catalog list and drift signal (read_products, read_publications)",
    query: `#graphql
      query ProbeCatalogs {
        catalogs(first: 25) {
          nodes {
            __typename
            id
            operations { __typename id status }
            publication { id autoPublish includedProductsCount { count precision } }
          }
        }
      }
    `,
  },
  {
    key: "markets",
    label: "Market names on market catalogs",
    purpose: "Whether read_markets is enough, or write_markets is also needed",
    query: `#graphql
      query ProbeMarkets {
        catalogs(first: 5, type: MARKET) {
          nodes {
            id
            ... on MarketCatalog { markets(first: 5) { nodes { id name } } }
          }
        }
      }
    `,
  },
  {
    key: "companyLocations",
    label: "Company and location names on B2B catalogs",
    purpose: "Whether read_companies is enough, or read_customers is also needed",
    query: `#graphql
      query ProbeCompanyLocations {
        catalogs(first: 5, type: COMPANY_LOCATION) {
          nodes {
            id
            ... on CompanyLocationCatalog {
              companyLocations(first: 5) { nodes { id name company { name } } }
            }
          }
        }
      }
    `,
  },
  {
    key: "channelPublication",
    label: "Online Store publication status for products",
    purpose: "Visibility check (a B2B buyer only sees products that are also on the Online Store)",
    query: `#graphql
      query ProbeChannelPublication {
        products(first: 5) {
          nodes {
            id
            resourcePublicationsV2(first: 5, onlyPublished: false) {
              nodes { isPublished publication { id catalog { __typename title } } }
            }
          }
        }
      }
    `,
  },
];

export async function runScopeProbes(admin: AdminGraphqlClient): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  // Run one at a time so the durations aren't skewed by each other.
  for (const probe of PROBES) {
    try {
      const result = await runGraphql(admin, probe.query, probe.variables);
      results.push({
        key: probe.key,
        label: probe.label,
        purpose: probe.purpose,
        ok: true,
        durationMs: result.durationMs,
        cost: result.cost,
        error: null,
      });
    } catch (error) {
      results.push({
        key: probe.key,
        label: probe.label,
        purpose: probe.purpose,
        ok: false,
        durationMs: error instanceof GraphqlRequestError ? error.durationMs : 0,
        cost: null,
        error: describeError(error),
      });
    }
  }
  return results;
}

export interface ShopDiagnostics {
  name: string;
  domain: string;
  planName: string;
  isPlus: boolean;
  isDevelopmentStore: boolean;
  grantedScopes: string[];
}

interface ShopQuery {
  shop: {
    name: string;
    myshopifyDomain: string;
    plan: { partnerDevelopment: boolean; shopifyPlus: boolean; publicDisplayName: string };
  };
  currentAppInstallation: { accessScopes: { handle: string }[] };
}

export async function getShopDiagnostics(admin: AdminGraphqlClient): Promise<ShopDiagnostics> {
  const { data } = await runGraphql<ShopQuery>(
    admin,
    `#graphql
      query DiagnosticsShop {
        shop {
          name
          myshopifyDomain
          plan { partnerDevelopment shopifyPlus publicDisplayName }
        }
        currentAppInstallation { accessScopes { handle } }
      }
    `,
  );
  return {
    name: data.shop.name,
    domain: data.shop.myshopifyDomain,
    planName: data.shop.plan.publicDisplayName,
    isPlus: data.shop.plan.shopifyPlus,
    isDevelopmentStore: data.shop.plan.partnerDevelopment,
    grantedScopes: data.currentAppInstallation.accessScopes.map((scope) => scope.handle).sort(),
  };
}

export interface RoundTripStep {
  label: string;
  ok: boolean;
  durationMs: number;
  cost: QueryCost | null;
  countAfter: number | null;
  error: string | null;
}

export interface RoundTripResult {
  productId: string | null;
  productTitle: string | null;
  countBefore: number | null;
  steps: RoundTripStep[];
  error: string | null;
}

interface MemberQuery {
  publication: {
    id: string;
    includedProductsCount: { count: number } | null;
    includedProducts: { nodes: { id: string; title: string }[] };
  } | null;
}

interface PublicationUpdateMutation {
  publicationUpdate: {
    publication: { id: string; includedProductsCount: { count: number } | null } | null;
    userErrors: { field: string[] | null; message: string; code: string | null }[];
  };
}

const PUBLICATION_UPDATE = `#graphql
  mutation DiagnosticsPublicationUpdate($id: ID!, $add: [ID!], $remove: [ID!]) {
    publicationUpdate(id: $id, input: { publishablesToAdd: $add, publishablesToRemove: $remove }) {
      publication { id includedProductsCount { count } }
      userErrors { field message code }
    }
  }
`;

/**
 * Removes the first product in a catalog's publication and adds it straight
 * back, timing both calls. Only for development stores: it briefly changes
 * what buyers in that catalog can see.
 */
export async function runPublicationRoundTrip(
  admin: AdminGraphqlClient,
  publicationId: string,
): Promise<RoundTripResult> {
  const members = await runGraphql<MemberQuery>(
    admin,
    `#graphql
      query DiagnosticsFirstMember($id: ID!) {
        publication(id: $id) {
          id
          includedProductsCount { count }
          includedProducts(first: 1) { nodes { id title } }
        }
      }
    `,
    { id: publicationId },
  );

  const product = members.data.publication?.includedProducts.nodes[0];
  const countBefore = members.data.publication?.includedProductsCount?.count ?? null;
  if (!product) {
    return {
      productId: null,
      productTitle: null,
      countBefore,
      steps: [],
      error: "This catalog has no products to test with.",
    };
  }

  const steps: RoundTripStep[] = [];
  const remove = await timedPublicationUpdate(admin, publicationId, "Remove 1 product", {
    remove: [product.id],
  });
  steps.push(remove);

  // Always try to put the product back, even if the removal reported a problem.
  steps.push(
    await timedPublicationUpdate(admin, publicationId, "Add it back", { add: [product.id] }),
  );

  return { productId: product.id, productTitle: product.title, countBefore, steps, error: null };
}

async function timedPublicationUpdate(
  admin: AdminGraphqlClient,
  publicationId: string,
  label: string,
  change: { add?: string[]; remove?: string[] },
): Promise<RoundTripStep> {
  try {
    const result = await runGraphql<PublicationUpdateMutation>(admin, PUBLICATION_UPDATE, {
      id: publicationId,
      add: change.add ?? [],
      remove: change.remove ?? [],
    });
    const { userErrors, publication } = result.data.publicationUpdate;
    return {
      label,
      ok: userErrors.length === 0,
      durationMs: result.durationMs,
      cost: result.cost,
      countAfter: publication?.includedProductsCount?.count ?? null,
      error: userErrors.length
        ? userErrors.map((e) => `${e.code ?? "ERROR"}: ${e.message}`).join("; ")
        : null,
    };
  } catch (error) {
    return {
      label,
      ok: false,
      durationMs: error instanceof GraphqlRequestError ? error.durationMs : 0,
      cost: null,
      countAfter: null,
      error: describeError(error),
    };
  }
}
