import { describeAssignmentCondition } from "./conditions";
import type { AssignmentDecision } from "./evaluate";
import type { AssignmentLocation } from "./locations.server";

/**
 * What saving an assignment rule set would do: which locations would gain
 * access to the catalog, which already have it, and which don't match.
 * Read-only; nothing here changes Shopify. Unlike product rules there's no
 * "would be removed" list: applying assignment rules is additive only
 * (CLAUDE.md decision), so a location that no longer matches just stays as
 * it is.
 */

export interface AssignmentPreviewRow {
  locationId: string;
  name: string;
  companyName: string;
  reason: string;
}

export interface AssignmentPreview {
  toAdd: number;
  alreadyAssigned: number;
  notMatched: number;
  addRows: AssignmentPreviewRow[];
  alreadyAssignedRows: AssignmentPreviewRow[];
  notMatchedRows: AssignmentPreviewRow[];
  /** Each list is cut to this many rows; the counts are complete */
  rowLimit: number;
}

export interface AssignmentPreviewInput {
  locations: AssignmentLocation[];
  /** The catalog's own Shopify GID, to check each location's current contexts */
  shopifyCatalogId: string;
  decisions: ReadonlyMap<string, AssignmentDecision>;
  /** Turns a metafield key into its definition name for the reasons */
  nameFor?: (key: string) => string | undefined;
  rowLimit?: number;
}

export function buildAssignmentPreview({
  locations,
  shopifyCatalogId,
  decisions,
  nameFor,
  rowLimit = 100,
}: AssignmentPreviewInput): AssignmentPreview {
  const addRows: AssignmentPreviewRow[] = [];
  const alreadyAssignedRows: AssignmentPreviewRow[] = [];
  const notMatchedRows: AssignmentPreviewRow[] = [];

  for (const location of locations) {
    const decision = decisions.get(location.locationId);
    const row: AssignmentPreviewRow = {
      locationId: location.locationId,
      name: location.name,
      companyName: location.companyName,
      reason:
        decision?.assigned && decision.matched.length > 0
          ? `Matches: ${decision.matched
              .map((condition) => describeAssignmentCondition(condition, nameFor))
              .join("; ")}`
          : "Doesn't match the rules",
    };

    if (!decision?.assigned) {
      notMatchedRows.push(row);
    } else if (location.currentCatalogIds.includes(shopifyCatalogId)) {
      alreadyAssignedRows.push(row);
    } else {
      addRows.push(row);
    }
  }

  return {
    toAdd: addRows.length,
    alreadyAssigned: alreadyAssignedRows.length,
    notMatched: notMatchedRows.length,
    addRows: addRows.slice(0, rowLimit),
    alreadyAssignedRows: alreadyAssignedRows.slice(0, rowLimit),
    notMatchedRows: notMatchedRows.slice(0, rowLimit),
    rowLimit,
  };
}
