import prisma from "../../db.server";
import type { CatalogType } from "@prisma/client";
import {
  runGraphql,
  type AdminGraphqlClient,
  type GraphqlResult,
} from "../shopify/graphql.server";
import {
  isSupportedMetafieldType,
  listItems,
  metafieldKey,
  type IndexedMetafields,
  type MetafieldType,
} from "../product-index/metafields";
import {
  validateCondition,
  type MatchMode,
  type RuleCondition,
} from "./conditions";
import type { Override } from "./evaluate";
import type { PreviewProduct } from "./preview";

/**
 * Server side of the rule builder: the catalog being edited, its saved
 * rules, the store's collections and the catalog's current products. Saving
 * rules only writes the app's database; applying them to Shopify is step 4.
 */

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const CATALOG_QUERY = `#graphql
  query RuleBuilderCatalog($id: ID!) {
    catalog(id: $id) {
      __typename
      id
      title
      status
      publication {
        id
        autoPublish
      }
    }
  }
`;

interface CatalogQuery {
  catalog: {
    __typename: string;
    id: string;
    title: string;
    status: string;
    publication: { id: string; autoPublish: boolean } | null;
  } | null;
}

export interface RuleCatalog {
  /** The app's Catalog row */
  recordId: string;
  shopifyCatalogId: string;
  type: CatalogType;
  title: string;
  status: string;
  publicationId: string | null;
  autoPublish: boolean | null;
}

/**
 * Reads the catalog from Shopify and makes sure the app has a Catalog row for
 * it (not managed until the merchant applies rules in step 4). Returns null
 * for a missing catalog or a sales channel catalog.
 */
export async function loadRuleCatalog(
  admin: AdminGraphqlClient,
  shopId: string,
  catalogId: string,
): Promise<RuleCatalog | null> {
  const { data } = await runGraphql<CatalogQuery>(admin, CATALOG_QUERY, {
    id: catalogId,
  });
  const catalog = data.catalog;
  const type = catalog && catalogType(catalog.__typename);
  if (!catalog || !type) return null;

  const fields = {
    type,
    title: catalog.title,
    publicationId: catalog.publication?.id ?? null,
  };
  const record = await prisma.catalog.upsert({
    where: {
      shopId_shopifyCatalogId: { shopId, shopifyCatalogId: catalog.id },
    },
    create: { shopId, shopifyCatalogId: catalog.id, ...fields },
    update: fields,
  });

  return {
    recordId: record.id,
    shopifyCatalogId: catalog.id,
    type,
    title: catalog.title,
    status: catalog.status,
    publicationId: fields.publicationId,
    autoPublish: catalog.publication?.autoPublish ?? null,
  };
}

function catalogType(typename: string): CatalogType | null {
  if (typename === "MarketCatalog") return "MARKET";
  if (typename === "CompanyLocationCatalog") return "COMPANY_LOCATION";
  return null;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface SavedRules {
  includeMatch: MatchMode;
  excludeMatch: MatchMode;
  conditions: RuleCondition[];
}

export async function loadRules(
  catalogRecordId: string,
): Promise<SavedRules | null> {
  const ruleSet = await prisma.ruleSet.findUnique({
    where: { catalogId_kind: { catalogId: catalogRecordId, kind: "CATALOG" } },
    include: { conditions: { orderBy: { position: "asc" } } },
  });
  if (!ruleSet) return null;
  return {
    includeMatch: ruleSet.includeMatch,
    excludeMatch: ruleSet.excludeMatch,
    conditions: ruleSet.conditions.map((c) => ({
      id: c.id,
      group: c.group,
      field: c.field,
      operator: c.operator,
      value: c.value,
      metafieldKey: c.metafieldKey,
      metafieldType: c.metafieldType,
    })),
  };
}

export type SaveResult = { ok: true } | { ok: false; errors: string[] };

/** Replaces the catalog's rules. Refuses rules with a broken condition. */
export async function saveRules(
  shopId: string,
  catalogRecordId: string,
  rules: SavedRules,
): Promise<SaveResult> {
  const errors = rules.conditions.flatMap(
    (condition) => validateCondition(condition) ?? [],
  );
  if (errors.length > 0) return { ok: false, errors };

  await prisma.$transaction(async (tx) => {
    const ruleSet = await tx.ruleSet.upsert({
      where: { catalogId_kind: { catalogId: catalogRecordId, kind: "CATALOG" } },
      create: {
        shopId,
        kind: "CATALOG",
        catalogId: catalogRecordId,
        includeMatch: rules.includeMatch,
        excludeMatch: rules.excludeMatch,
      },
      update: {
        includeMatch: rules.includeMatch,
        excludeMatch: rules.excludeMatch,
      },
    });
    await tx.condition.deleteMany({ where: { ruleSetId: ruleSet.id } });
    await tx.condition.createMany({
      data: rules.conditions.map((condition, position) => ({
        ruleSetId: ruleSet.id,
        group: condition.group,
        field: condition.field,
        operator: condition.operator,
        value: condition.value?.trim() || null,
        // Only metafield conditions name a metafield.
        metafieldKey:
          condition.field === "metafield"
            ? (condition.metafieldKey ?? null)
            : null,
        metafieldType:
          condition.field === "metafield"
            ? (condition.metafieldType ?? null)
            : null,
        position,
      })),
    });
  });
  return { ok: true };
}

export async function loadOverrides(
  catalogRecordId: string,
): Promise<Map<string, Override>> {
  const overrides = await prisma.override.findMany({
    where: { catalogId: catalogRecordId },
  });
  return new Map(overrides.map((o) => [o.productId, o.kind]));
}

/** The index rows rules test, plus the title for display. */
export async function loadIndexProducts(
  shopId: string,
): Promise<PreviewProduct[]> {
  const rows = await prisma.productIndex.findMany({
    where: { shopId },
    select: {
      productId: true,
      title: true,
      status: true,
      vendor: true,
      productType: true,
      tags: true,
      categoryId: true,
      collectionIds: true,
      onlineStorePublished: true,
      metafields: true,
    },
    orderBy: { title: "asc" },
  });
  // The metafields column holds what upsertProducts wrote (IndexedMetafields).
  return rows.map((row) => ({
    ...row,
    metafields: (row.metafields ?? null) as IndexedMetafields | null,
  }));
}

// ---------------------------------------------------------------------------
// Metafield definitions (for the picker and for naming them in reasons)
// ---------------------------------------------------------------------------

const METAFIELD_DEFINITIONS_QUERY = `#graphql
  query RuleBuilderMetafieldDefinitions($cursor: String) {
    metafieldDefinitions(ownerType: PRODUCT, first: 250, after: $cursor) {
      nodes {
        namespace
        key
        name
        type {
          name
        }
        validations {
          name
          value
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface MetafieldDefinitionsPage {
  metafieldDefinitions: {
    nodes: {
      namespace: string;
      key: string;
      name: string;
      type: { name: string };
      validations: { name: string; value: string | null }[];
    }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface RuleMetafieldDefinition {
  /** "namespace.key" */
  key: string;
  name: string;
  type: MetafieldType;
  /** Allowed values, when the definition limits them (the "choices" validation) */
  choices: string[] | null;
}

/** Product metafield definitions with a type rules can test. */
export async function listMetafieldDefinitions(
  admin: AdminGraphqlClient,
): Promise<RuleMetafieldDefinition[]> {
  const definitions: RuleMetafieldDefinition[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const result: GraphqlResult<MetafieldDefinitionsPage> =
      await runGraphql<MetafieldDefinitionsPage>(
        admin,
        METAFIELD_DEFINITIONS_QUERY,
        { cursor },
      );
    for (const node of result.data.metafieldDefinitions.nodes) {
      if (!isSupportedMetafieldType(node.type.name)) continue;
      const choices = node.validations.find((v) => v.name === "choices")?.value;
      definitions.push({
        key: metafieldKey(node.namespace, node.key),
        name: node.name,
        type: node.type.name,
        choices: choices ? listItems(choices) : null,
      });
    }
    const { hasNextPage, endCursor } =
      result.data.metafieldDefinitions.pageInfo;
    if (!hasNextPage || !endCursor) break;
    cursor = endCursor;
  }
  return definitions.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Definitions, plus metafields found in the product index that have no
 * definition (imported, or written by other apps), named by their key.
 */
export async function listRuleMetafields(
  admin: AdminGraphqlClient,
  shopId: string,
): Promise<RuleMetafieldDefinition[]> {
  const [definitions, indexed] = await Promise.all([
    listMetafieldDefinitions(admin),
    // One row per key. A metafield with no definition can have a different
    // type on different products; use the type most products have.
    prisma.$queryRaw<{ key: string; type: string }[]>`
      SELECT DISTINCT ON (field.key) field.key AS key, field.value->>'type' AS type
      FROM "ProductIndex", jsonb_each("metafields") AS field
      WHERE "shopId" = ${shopId} AND jsonb_typeof("metafields") = 'object'
      GROUP BY field.key, field.value->>'type'
      ORDER BY field.key, count(*) DESC
    `,
  ]);

  const known = new Set(definitions.map((d) => d.key));
  const undefinedOnes = indexed
    .filter((m) => !known.has(m.key) && isSupportedMetafieldType(m.type))
    .map((m): RuleMetafieldDefinition => ({
      key: m.key,
      name: m.key,
      type: m.type as MetafieldType,
      choices: null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return [...definitions, ...undefinedOnes];
}

// ---------------------------------------------------------------------------
// Collections (for the picker and for naming them in reasons)
// ---------------------------------------------------------------------------

const COLLECTIONS_QUERY = `#graphql
  query RuleBuilderCollections($cursor: String) {
    collections(first: 250, after: $cursor, sortKey: TITLE) {
      nodes {
        id
        title
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface CollectionsPage {
  collections: {
    nodes: { id: string; title: string }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/** Up to 5,000 collections, which is plenty for a picker. */
export async function listCollections(
  admin: AdminGraphqlClient,
): Promise<{ id: string; title: string }[]> {
  const collections: { id: string; title: string }[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result: GraphqlResult<CollectionsPage> =
      await runGraphql<CollectionsPage>(admin, COLLECTIONS_QUERY, { cursor });
    collections.push(...result.data.collections.nodes);
    const { hasNextPage, endCursor } = result.data.collections.pageInfo;
    if (!hasNextPage || !endCursor) break;
    cursor = endCursor;
  }
  return collections;
}

const COLLECTION_NAMES_QUERY = `#graphql
  query RuleBuilderCollectionNames($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Collection {
        id
        title
      }
    }
  }
`;

/**
 * Titles for the given collections only: the live preview needs names for
 * the collections its rules use, not the whole list the picker loads.
 */
export async function getCollectionNames(
  admin: AdminGraphqlClient,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { data } = await runGraphql<{
    nodes: ({ id?: string; title?: string } | null)[];
  }>(admin, COLLECTION_NAMES_QUERY, { ids: unique });
  return new Map(
    data.nodes.flatMap((node) =>
      node?.id && node.title ? [[node.id, node.title] as const] : [],
    ),
  );
}

// ---------------------------------------------------------------------------
// Current catalog membership
// ---------------------------------------------------------------------------

const MEMBERSHIP_QUERY = `#graphql
  query RuleBuilderMembership($id: ID!, $cursor: String) {
    publication(id: $id) {
      includedProducts(first: 250, after: $cursor) {
        nodes {
          id
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

interface MembershipPage {
  publication: {
    includedProducts: {
      nodes: { id: string }[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

/**
 * The live preview asks for membership on every edit, so a publication's
 * product list is cached briefly. In-process like the other stopgaps until
 * the queue and Redis arrive in step 5.
 */
const MEMBERSHIP_CACHE_MS = 2 * 60_000;
const membershipCache = new Map<string, { at: number; ids: string[] }>();

/**
 * The publication's includedProducts (membership, including drafts and
 * archived: spike finding 9), or null if the publication no longer exists
 * (deleted, or the catalog's publication was swapped). Null is never cached,
 * and never treated as an empty list: an empty list would show every product
 * as "to add".
 */
export async function getCatalogMembership(
  admin: AdminGraphqlClient,
  publicationId: string,
  /** Skip the cache: a sync must diff against what's in Shopify right now. */
  { fresh = false }: { fresh?: boolean } = {},
): Promise<string[] | null> {
  const cached = membershipCache.get(publicationId);
  if (!fresh && cached && Date.now() - cached.at < MEMBERSHIP_CACHE_MS) {
    return cached.ids;
  }

  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: GraphqlResult<MembershipPage> =
      await runGraphql<MembershipPage>(admin, MEMBERSHIP_QUERY, {
        id: publicationId,
        cursor,
      });
    const page: MembershipPage["publication"] = result.data.publication;
    if (!page) {
      membershipCache.delete(publicationId);
      return null;
    }
    ids.push(...page.includedProducts.nodes.map((product) => product.id));
    const { hasNextPage, endCursor } = page.includedProducts.pageInfo;
    if (!hasNextPage || !endCursor) break;
    cursor = endCursor;
  }

  membershipCache.set(publicationId, { at: Date.now(), ids });
  return ids;
}

/** After a sync the cached list is out of date. */
export function forgetCatalogMembership(publicationId: string): void {
  membershipCache.delete(publicationId);
}

/**
 * Names for the collections, metafields and categories a rule set uses, so
 * reasons read "Collection is in Home page", "Trade tier is gold" and
 * "Category is Snowboards".
 */
export async function ruleNames(
  admin: AdminGraphqlClient,
  conditions: RuleCondition[],
): Promise<Map<string, string>> {
  const collectionIds = conditions.flatMap((c) =>
    c.field === "in_collection" && c.value ? [c.value] : [],
  );
  const categoryIds = conditions.flatMap((c) =>
    c.field === "category" && c.value ? [c.value] : [],
  );
  const usesMetafields = conditions.some((c) => c.field === "metafield");
  const [collectionNames, categoryNames, definitions] = await Promise.all([
    getCollectionNames(admin, collectionIds),
    getCategoryNames(admin, categoryIds),
    usesMetafields ? listMetafieldDefinitions(admin) : [],
  ]);
  const names = new Map([...collectionNames, ...categoryNames]);
  for (const definition of definitions)
    names.set(definition.key, definition.name);
  return names;
}

// ---------------------------------------------------------------------------
// Category (taxonomy) picker
// ---------------------------------------------------------------------------

export interface RuleCategory {
  /** Taxonomy category GID, e.g. "gid://shopify/TaxonomyCategory/sg-4-17-2-17" */
  id: string;
  name: string;
  /** Full breadcrumb, e.g. "Sporting Goods > Outdoor Recreation > Snowboarding > Snowboards" */
  fullName: string;
}

const CATEGORY_SEARCH_QUERY = `#graphql
  query RuleBuilderCategorySearch($search: String!) {
    taxonomy {
      categories(search: $search, first: 20) {
        nodes {
          id
          name
          fullName
        }
      }
    }
  }
`;

interface CategorySearchResult {
  taxonomy: { categories: { nodes: RuleCategory[] } };
}

/** Categories matching a search term, for the rule builder's category picker. */
export async function searchCategories(
  admin: AdminGraphqlClient,
  search: string,
): Promise<RuleCategory[]> {
  if (!search.trim()) return [];
  const { data } = await runGraphql<CategorySearchResult>(admin, CATEGORY_SEARCH_QUERY, {
    search,
  });
  return data.taxonomy.categories.nodes;
}

const CATEGORY_NAMES_QUERY = `#graphql
  query RuleBuilderCategoryNames($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on TaxonomyCategory {
        id
        name
        fullName
      }
    }
  }
`;

/**
 * Full names for the given categories only: a saved rule's category
 * condition needs its breadcrumb name without searching the whole taxonomy.
 */
export async function getCategoryNames(
  admin: AdminGraphqlClient,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { data } = await runGraphql<{
    nodes: ({ id?: string; fullName?: string } | null)[];
  }>(admin, CATEGORY_NAMES_QUERY, { ids: unique });
  return new Map(
    data.nodes.flatMap((node) =>
      node?.id && node.fullName ? [[node.id, node.fullName] as const] : [],
    ),
  );
}
