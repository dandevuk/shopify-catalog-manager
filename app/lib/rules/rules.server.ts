import prisma from "../../db.server";
import type { CatalogType } from "@prisma/client";
import {
  runGraphql,
  type AdminGraphqlClient,
  type GraphqlResult,
} from "../shopify/graphql.server";
import {
  validateCondition,
  type MatchMode,
  type RuleCondition,
} from "./conditions";
import type { Override } from "./evaluate";

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
    where: { catalogId: catalogRecordId },
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
      where: { catalogId: catalogRecordId },
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
        value: condition.value?.trim() ?? null,
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
export async function loadIndexProducts(shopId: string) {
  return prisma.productIndex.findMany({
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
    },
    orderBy: { title: "asc" },
  });
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
 * archived: spike finding 9).
 */
export async function getCatalogMembership(
  admin: AdminGraphqlClient,
  publicationId: string,
): Promise<string[]> {
  const cached = membershipCache.get(publicationId);
  if (cached && Date.now() - cached.at < MEMBERSHIP_CACHE_MS) return cached.ids;

  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: GraphqlResult<MembershipPage> =
      await runGraphql<MembershipPage>(admin, MEMBERSHIP_QUERY, {
        id: publicationId,
        cursor,
      });
    const page: MembershipPage["publication"] = result.data.publication;
    if (!page) break;
    ids.push(...page.includedProducts.nodes.map((product) => product.id));
    const { hasNextPage, endCursor } = page.includedProducts.pageInfo;
    if (!hasNextPage || !endCursor) break;
    cursor = endCursor;
  }

  membershipCache.set(publicationId, { at: Date.now(), ids });
  return ids;
}
