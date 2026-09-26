import {
  runGraphql,
  type AdminGraphqlClient,
} from "../shopify/graphql.server";

/**
 * Applies assignment rules to Shopify: adds the matched, not-yet-assigned
 * locations to a catalog's context with catalogContextUpdate. Additive
 * only (CLAUDE.md decision): this never calls contextsToRemove, so it can
 * never take a location out of a catalog a merchant assigned by hand.
 *
 * One call for the whole list: unlike publicationUpdate (spike finding 1),
 * catalogContextUpdate has no documented per-call limit, and company
 * location counts are far smaller than product counts (CLAUDE.md), so
 * chunking isn't needed for v1.
 */

const CATALOG_CONTEXT_UPDATE = `#graphql
  mutation AssignmentApply($catalogId: ID!, $companyLocationIds: [ID!]!) {
    catalogContextUpdate(
      catalogId: $catalogId
      contextsToAdd: { companyLocationIds: $companyLocationIds }
    ) {
      catalog {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface CatalogContextUpdateResult {
  catalogContextUpdate: {
    catalog: { id: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

export interface AssignmentApplyResult {
  /** Location IDs Shopify confirmed were added */
  added: string[];
  /** Set when Shopify rejected the call; every requested ID is unapplied */
  error: string | null;
}

export async function applyAssignments(
  admin: AdminGraphqlClient,
  shopifyCatalogId: string,
  locationIds: string[],
): Promise<AssignmentApplyResult> {
  if (locationIds.length === 0) return { added: [], error: null };

  const { data } = await runGraphql<CatalogContextUpdateResult>(
    admin,
    CATALOG_CONTEXT_UPDATE,
    { catalogId: shopifyCatalogId, companyLocationIds: locationIds },
  );

  const userErrors = data.catalogContextUpdate.userErrors;
  if (userErrors.length > 0) {
    return {
      added: [],
      error: userErrors.map((e) => e.message).join(" "),
    };
  }
  return { added: locationIds, error: null };
}
