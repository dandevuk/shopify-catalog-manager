import {
  isSupportedMetafieldType,
  listItems,
  metafieldKey,
  pickMetafields,
  type MetafieldType,
} from "../product-index/metafields";
import {
  runGraphql,
  type AdminGraphqlClient,
  type GraphqlResult,
} from "../shopify/graphql.server";
import { waitForCost } from "../sync/apply.server";
import type { AssignmentConditionField } from "./conditions";
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
          # One page, not paginated: a company/location isn't expected to
          # carry hundreds of metafields (same assumption as the assignment
          # metafield definitions query).
          metafields(first: 250) {
            nodes { namespace key type value }
          }
        }
        metafields(first: 250) {
          nodes { namespace key type value }
        }
        # One page, not paginated: a location isn't expected to have its own
        # context on dozens of catalogs. If it ever does, only the first 50
        # are seen here, which could miss the target catalog and misreport an
        # already-assigned location as "would be added".
        catalogs(first: 50) {
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
 * mean one round trip per company). Waits out the throttle bucket between
 * pages the same way `sync/apply.server.ts` does for repeated writes
 * (CLAUDE.md's "Measured performance": non-Plus shops have a much smaller
 * bucket) — though every shop that can reach this code is on Plus, since B2B
 * catalogs are a Plus-only feature (finding 11), so this is mostly headroom
 * for a shop with many locations, not an expected everyday wait.
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
    const wait = waitForCost(result.cost);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  return locations;
}

// ---------------------------------------------------------------------------
// Metafield definitions (for the assignment rule builder)
// ---------------------------------------------------------------------------

const METAFIELD_DEFINITIONS_QUERY = `#graphql
  query AssignmentMetafieldDefinitions {
    company: metafieldDefinitions(ownerType: COMPANY, first: 250) {
      nodes {
        namespace
        key
        name
        type { name }
        validations { name value }
      }
    }
    companyLocation: metafieldDefinitions(ownerType: COMPANY_LOCATION, first: 250) {
      nodes {
        namespace
        key
        name
        type { name }
        validations { name value }
      }
    }
  }
`;

interface MetafieldDefinitionNode {
  namespace: string;
  key: string;
  name: string;
  type: { name: string };
  validations: { name: string; value: string | null }[];
}

interface MetafieldDefinitionsResult {
  company: { nodes: MetafieldDefinitionNode[] };
  companyLocation: { nodes: MetafieldDefinitionNode[] };
}

export interface AssignmentMetafieldDefinition {
  field: AssignmentConditionField;
  /** "namespace.key" */
  key: string;
  name: string;
  type: MetafieldType;
  /** Allowed values, when the definition limits them (the "choices" validation) */
  choices: string[] | null;
}

/**
 * Company and location metafield definitions with a type rules can test.
 * Unlike products, a store isn't expected to have hundreds of these, so this
 * reads one page of each (250) rather than paginating.
 */
export async function listAssignmentMetafieldDefinitions(
  admin: AdminGraphqlClient,
): Promise<AssignmentMetafieldDefinition[]> {
  const { data } = await runGraphql<MetafieldDefinitionsResult>(
    admin,
    METAFIELD_DEFINITIONS_QUERY,
  );

  const toDefinitions = (
    field: AssignmentConditionField,
    nodes: MetafieldDefinitionNode[],
  ): AssignmentMetafieldDefinition[] =>
    nodes.flatMap((node): AssignmentMetafieldDefinition[] => {
      if (!isSupportedMetafieldType(node.type.name)) return [];
      const choices = node.validations.find((v) => v.name === "choices")?.value;
      return [
        {
          field,
          key: metafieldKey(node.namespace, node.key),
          name: node.name,
          type: node.type.name,
          choices: choices ? listItems(choices) : null,
        },
      ];
    });

  return [
    ...toDefinitions("company_metafield", data.company.nodes),
    ...toDefinitions("location_metafield", data.companyLocation.nodes),
  ].sort((a, b) => a.name.localeCompare(b.name));
}
