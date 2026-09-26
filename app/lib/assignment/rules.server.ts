import prisma from "../../db.server";
import type { MatchMode } from "../rules/conditions";
import {
  validateAssignmentCondition,
  type AssignmentCondition,
} from "./conditions";

/**
 * Server side of the assignment rule builder (Phase 2): load and save a
 * COMPANY_LOCATION catalog's assignment rule set (RuleSet.kind ASSIGNMENT).
 * Mirrors `app/lib/rules/rules.server.ts`'s loadRules/saveRules, but there's
 * only ever an include group: assignment conditions have no exclude side
 * (CLAUDE.md decision), so every Condition row this writes has
 * group = INCLUDE regardless (the column is shared with product rules).
 */

export interface SavedAssignmentRules {
  includeMatch: MatchMode;
  conditions: AssignmentCondition[];
}

export async function loadAssignmentRules(
  catalogRecordId: string,
): Promise<SavedAssignmentRules | null> {
  const ruleSet = await prisma.ruleSet.findUnique({
    where: { catalogId_kind: { catalogId: catalogRecordId, kind: "ASSIGNMENT" } },
    include: { conditions: { orderBy: { position: "asc" } } },
  });
  if (!ruleSet) return null;
  return {
    includeMatch: ruleSet.includeMatch,
    conditions: ruleSet.conditions.map((c) => ({
      id: c.id,
      field: c.field,
      operator: c.operator,
      value: c.value,
      metafieldKey: c.metafieldKey,
      metafieldType: c.metafieldType,
    })),
  };
}

export type SaveAssignmentResult = { ok: true } | { ok: false; errors: string[] };

/** Replaces the catalog's assignment rules. Refuses a broken condition. */
export async function saveAssignmentRules(
  shopId: string,
  catalogRecordId: string,
  rules: SavedAssignmentRules,
): Promise<SaveAssignmentResult> {
  const errors = rules.conditions.flatMap(
    (condition) => validateAssignmentCondition(condition) ?? [],
  );
  if (errors.length > 0) return { ok: false, errors };

  await prisma.$transaction(async (tx) => {
    const ruleSet = await tx.ruleSet.upsert({
      where: { catalogId_kind: { catalogId: catalogRecordId, kind: "ASSIGNMENT" } },
      create: {
        shopId,
        kind: "ASSIGNMENT",
        catalogId: catalogRecordId,
        includeMatch: rules.includeMatch,
      },
      update: { includeMatch: rules.includeMatch },
    });
    await tx.condition.deleteMany({ where: { ruleSetId: ruleSet.id } });
    await tx.condition.createMany({
      data: rules.conditions.map((condition, position) => ({
        ruleSetId: ruleSet.id,
        group: "INCLUDE" as const,
        field: condition.field,
        operator: condition.operator,
        value: condition.value?.trim() || null,
        metafieldKey: condition.metafieldKey ?? null,
        metafieldType: condition.metafieldType ?? null,
        position,
      })),
    });
  });
  return { ok: true };
}
