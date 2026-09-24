import {
  runGraphql,
  type AdminGraphqlClient,
  type GraphqlResult,
  type QueryCost,
} from "./graphql.server";

/**
 * Reads Market and B2B catalogs with the fields the app cares about:
 * publication, product count, autoPublish and the latest background operation
 * (the drift signal from spike finding 2).
 *
 * Sales channel catalogs (AppCatalog) are skipped; the app doesn't manage them.
 */

export type ManagedCatalogType = "MARKET" | "COMPANY_LOCATION";

export interface CatalogSummary {
  id: string;
  type: ManagedCatalogType;
  title: string;
  status: string;
  /** Market names, or "Company / Location" labels for B2B catalogs */
  contexts: string[];
  contextCount: number;
  publicationId: string | null;
  autoPublish: boolean | null;
  productCount: number | null;
  productCountIsExact: boolean;
  latestOperation: { id: string; type: string; status: string } | null;
}

export interface CatalogListResult {
  catalogs: CatalogSummary[];
  /** Set when the market/company details couldn't be read (e.g. missing scope) */
  contextError: string | null;
  cost: QueryCost | null;
  durationMs: number;
}

export const CATALOG_LIST_QUERY = `#graphql
  query CatalogList($cursor: String) {
    catalogs(first: 50, after: $cursor) {
      nodes {
        __typename
        id
        title
        status
        operations {
          __typename
          id
          status
        }
        publication {
          id
          autoPublish
          includedProductsCount {
            count
            precision
          }
        }
        ... on MarketCatalog {
          markets(first: 10) {
            nodes {
              id
              name
            }
          }
        }
        ... on CompanyLocationCatalog {
          companyLocationsCount {
            count
          }
          companyLocations(first: 10) {
            nodes {
              id
              name
              company {
                name
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** Same as CATALOG_LIST_QUERY without market/company details (fewer scopes). */
export const CATALOG_LIST_BASIC_QUERY = `#graphql
  query CatalogListBasic($cursor: String) {
    catalogs(first: 50, after: $cursor) {
      nodes {
        __typename
        id
        title
        status
        operations {
          __typename
          id
          status
        }
        publication {
          id
          autoPublish
          includedProductsCount {
            count
            precision
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface CatalogNode {
  __typename: string;
  id: string;
  title: string;
  status: string;
  operations: { __typename: string; id: string; status: string }[];
  publication: {
    id: string;
    autoPublish: boolean;
    includedProductsCount: { count: number; precision: string } | null;
  } | null;
  markets?: { nodes: { id: string; name: string }[] };
  companyLocationsCount?: { count: number } | null;
  companyLocations?: {
    nodes: { id: string; name: string; company: { name: string } | null }[];
  };
}

interface CatalogPage {
  catalogs: {
    nodes: CatalogNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

const MAX_PAGES = 20;

async function fetchAllCatalogNodes(admin: AdminGraphqlClient, query: string) {
  const nodes: CatalogNode[] = [];
  let cursor: string | null = null;
  let cost: QueryCost | null = null;
  let durationMs = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result: GraphqlResult<CatalogPage> = await runGraphql<CatalogPage>(admin, query, {
      cursor,
    });
    nodes.push(...result.data.catalogs.nodes);
    cost = result.cost;
    durationMs += result.durationMs;

    const pageInfo: CatalogPage["catalogs"]["pageInfo"] = result.data.catalogs.pageInfo;
    const { hasNextPage, endCursor } = pageInfo;
    if (!hasNextPage || !endCursor) break;
    cursor = endCursor;
  }

  return { nodes, cost, durationMs };
}

export async function listCatalogs(admin: AdminGraphqlClient): Promise<CatalogListResult> {
  try {
    const { nodes, cost, durationMs } = await fetchAllCatalogNodes(admin, CATALOG_LIST_QUERY);
    return { catalogs: toSummaries(nodes), contextError: null, cost, durationMs };
  } catch (error) {
    // Fall back to the basic query so the page still works if market or
    // company details need a scope the app doesn't have yet.
    const { nodes, cost, durationMs } = await fetchAllCatalogNodes(
      admin,
      CATALOG_LIST_BASIC_QUERY,
    );
    return {
      catalogs: toSummaries(nodes),
      contextError: error instanceof Error ? error.message : String(error),
      cost,
      durationMs,
    };
  }
}

function toSummaries(nodes: CatalogNode[]): CatalogSummary[] {
  return nodes.flatMap((node): CatalogSummary[] => {
    const type = catalogType(node.__typename);
    if (!type) return [];

    const contexts =
      type === "MARKET"
        ? (node.markets?.nodes ?? []).map((market) => market.name)
        : (node.companyLocations?.nodes ?? []).map((location) =>
            location.company ? `${location.company.name} / ${location.name}` : location.name,
          );

    const contextCount =
      type === "COMPANY_LOCATION"
        ? node.companyLocationsCount?.count ?? contexts.length
        : contexts.length;

    const latest = node.operations[0];

    return [
      {
        id: node.id,
        type,
        title: node.title,
        status: node.status,
        contexts,
        contextCount,
        publicationId: node.publication?.id ?? null,
        autoPublish: node.publication?.autoPublish ?? null,
        productCount: node.publication?.includedProductsCount?.count ?? null,
        productCountIsExact: node.publication?.includedProductsCount?.precision !== "AT_LEAST",
        latestOperation: latest
          ? { id: latest.id, type: latest.__typename, status: latest.status }
          : null,
      },
    ];
  });
}

function catalogType(typename: string): ManagedCatalogType | null {
  if (typename === "MarketCatalog") return "MARKET";
  if (typename === "CompanyLocationCatalog") return "COMPANY_LOCATION";
  return null;
}
