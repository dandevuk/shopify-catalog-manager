import { pickMetafields } from "../product-index/metafields";
import {
  runGraphql,
  type AdminGraphqlClient,
  type GraphqlResult,
} from "../shopify/graphql.server";
import type { RuleLocation } from "./evaluate";

/**
 * Company location data for B2B catalog assignment rules (Phase 2). Read
 * live at preview/apply time (finding 20: `read_companies` alone is enough,
 * no `read_customers`), never indexed: company/location counts are far
 * smaller than product counts.
 */

const LOCATIONS_QUERY = `#graphql
  query AssignmentLocations($cursor: String) {
    companyLocations(first: 50, after: $cursor) {
      nodes {
        id
        name
        company {
          id
          name
          metafields(first: 50) {
            nodes { namespace key type value }
          }
        }
        metafields(first: 50) {
          nodes { namespace key type value }
        }
        catalogs(first: 10) {
          nodes { id }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface MetafieldNode {
  namespace: string;
  key: string;
  type: string;
  value: string | null;
}

interface LocationsPage {
  companyLocations: {
    nodes: {
      id: string;
      name: string;
      company: {
        id: string;
        name: string;
        metafields: { nodes: MetafieldNode[] };
      };
      metafields: { nodes: MetafieldNode[] };
      catalogs: { nodes: { id: string }[] };
    }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface AssignmentLocation extends RuleLocation {
  /** Shopify catalog GIDs this location already has access to */
  currentCatalogIds: string[];
}

/**
 * Every company location on the shop, read a page at a time from the
 * top-level `companyLocations` query (not `company.locations`, which would
 * mean one round trip per company).
 */
const MAX_PAGES = 20;

export async function listAssignmentLocations(
  admin: AdminGraphqlClient,
): Promise<AssignmentLocation[]> {
  const locations: AssignmentLocation[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const result: GraphqlResult<LocationsPage> = await runGraphql<LocationsPage>(
      admin,
      LOCATIONS_QUERY,
      { cursor },
    );
    for (const node of result.data.companyLocations.nodes) {
      locations.push({
        locationId: node.id,
        name: node.name,
        companyId: node.company.id,
        companyName: node.company.name,
        companyMetafields: pickMetafields(node.company.metafields.nodes),
        locationMetafields: pickMetafields(node.metafields.nodes),
        currentCatalogIds: node.catalogs.nodes.map((catalog) => catalog.id),
      });
    }
    const { hasNextPage, endCursor } = result.data.companyLocations.pageInfo;
    if (!hasNextPage || !endCursor) break;
    cursor = endCursor;
  }

  return locations;
}
