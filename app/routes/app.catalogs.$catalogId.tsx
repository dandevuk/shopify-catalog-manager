import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useParams,
  useRevalidator,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../lib/shop.server";
import { fromCatalogParam } from "../lib/shopify/catalog-id";
import {
  FIELDS,
  operatorLabel,
  operatorsFor,
  operatorTakesValue,
  validateCondition,
  type ConditionField,
  type ConditionGroup,
  type ConditionOperator,
  type MatchMode,
  type RuleCondition,
} from "../lib/rules/conditions";
import { evaluateRuleSet } from "../lib/rules/evaluate";
import {
  buildPreview,
  type Preview,
  type PreviewRow,
} from "../lib/rules/preview";
import {
  isAssignmentField,
  operatorsFor as assignmentOperatorsFor,
  validateAssignmentCondition,
  type AssignmentCondition,
  type AssignmentConditionField,
} from "../lib/assignment/conditions";
import { evaluateAssignmentRules } from "../lib/assignment/evaluate";
import {
  listAssignmentLocations,
  listAssignmentMetafieldDefinitions,
  type AssignmentMetafieldDefinition,
} from "../lib/assignment/locations.server";
import {
  buildAssignmentPreview,
  isUnassignedMatch,
  type AssignmentPreview,
  type AssignmentPreviewRow,
} from "../lib/assignment/preview";
import { applyAssignments } from "../lib/assignment/apply.server";
import {
  loadAssignmentRules,
  saveAssignmentRules,
  type SavedAssignmentRules,
} from "../lib/assignment/rules.server";
import { countProducts } from "../lib/product-index/store.server";
import {
  getCatalogMembership,
  getCategoryNames,
  listCollections,
  listRuleMetafields,
  loadIndexProducts,
  loadOverrides,
  loadRuleCatalog,
  loadRules,
  ruleNames,
  saveRules,
  searchCategories,
  type RuleCategory,
  type RuleMetafieldDefinition,
  type SavedRules,
} from "../lib/rules/rules.server";
import { metafieldKind } from "../lib/product-index/metafields";
import {
  getSyncStatus,
  previewSync,
  startSync,
  stopManaging,
  type SyncPreview,
  type SyncStatus,
} from "../lib/sync/managed.server";
import {
  describeConfirmation,
  type Acknowledgement,
  type Confirmation,
} from "../lib/sync/plan";
import { formatDateTime } from "../lib/format";

/**
 * Rule builder: edit a catalog's include and exclude conditions and see
 * which products they'd put in it, compared with what's in it now. Saving
 * stores the rules in the app; "Apply to Shopify" (managed mode) makes the
 * catalog match the saved rules.
 */

async function loadContext(request: Request, param: string | undefined) {
  const { admin, session } = await authenticate.admin(request);
  const catalogId = fromCatalogParam(param);
  if (!catalogId)
    throw new Response("Not a Market or B2B catalog", { status: 404 });

  const shop = await ensureShop(session.shop);
  const catalog = await loadRuleCatalog(admin, shop.id, catalogId);
  if (!catalog) throw new Response("Catalog not found", { status: 404 });
  return { admin, shop, catalog };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, shop, catalog } = await loadContext(request, params.catalogId);
  const isB2B = catalog.type === "COMPANY_LOCATION";
  const [rules, collections, metafieldDefinitions, assignmentRules, assignmentMetafieldDefinitions] =
    await Promise.all([
      loadRules(catalog.recordId),
      listCollections(admin),
      listRuleMetafields(admin, shop.id),
      isB2B ? loadAssignmentRules(catalog.recordId) : null,
      isB2B ? listAssignmentMetafieldDefinitions(admin) : [],
    ]);
  // Depends on which categories the saved rules use, so this can only start
  // once `rules` is in.
  const savedCategoryIds = (rules?.conditions ?? []).flatMap((c) =>
    c.field === "category" && c.value ? [c.value] : [],
  );
  const categoryNames = await getCategoryNames(admin, savedCategoryIds);

  return {
    catalog: {
      title: catalog.title,
      type: catalog.type,
      status: catalog.status,
      hasPublication: catalog.publicationId !== null,
      autoPublish: catalog.autoPublish,
    },
    rules: rules ?? {
      includeMatch: "ALL" as MatchMode,
      excludeMatch: "ANY" as MatchMode,
      conditions: [],
    },
    collections,
    metafieldDefinitions,
    categoryNames: [...categoryNames],
    indexedProducts: await countProducts(shop.id),
    syncStatus: await getSyncStatus(catalog.recordId),
    /** False until rules are saved for this catalog the first time */
    hasSavedRules: rules !== null,
    assignmentRules: assignmentRules ?? {
      includeMatch: "ALL" as MatchMode,
      conditions: [],
    },
    hasSavedAssignmentRules: assignmentRules !== null,
    assignmentMetafieldDefinitions,
  };
};

/**
 * React Router re-runs loaders after every action. A live preview changes
 * nothing the loader reads, and re-running it on each edit would re-read the
 * catalog and every collection, so skip it for previews.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  actionResult,
  defaultShouldRevalidate,
}) => {
  const intent = (actionResult as ActionResult | undefined)?.intent;
  if (
    intent === "preview" ||
    intent === "assignment-preview" ||
    intent === "search-categories"
  )
    return false;
  return defaultShouldRevalidate;
};

type ActionResult =
  | { intent: "preview"; preview: Preview }
  | { intent: "save"; ok: true }
  | { intent: "save" | "preview"; ok: false; errors: string[] }
  | { intent: "sync-preview"; syncPreview: SyncPreview }
  | { intent: "sync-start"; ok: true }
  | { intent: "sync-start"; ok: false; error: string }
  | { intent: "stop-managing"; ok: true }
  | { intent: "assignment-preview"; ok: true; preview: AssignmentPreview }
  | {
      intent: "assignment-preview" | "assignment-save" | "assignment-apply";
      ok: false;
      errors: string[];
    }
  | { intent: "assignment-save"; ok: true }
  | { intent: "assignment-apply"; ok: true; added: number }
  | { intent: "search-categories"; categories: RuleCategory[] };

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { admin, shop, catalog } = await loadContext(request, params.catalogId);
  const body = (await request.json()) as {
    intent:
      | "preview"
      | "save"
      | "sync-preview"
      | "sync-start"
      | "stop-managing"
      | "assignment-preview"
      | "assignment-save"
      | "assignment-apply"
      | "search-categories";
    rules?: SavedRules;
    assignmentRules?: SavedAssignmentRules;
    acknowledgement?: Acknowledgement;
    query?: string;
  };

  if (body.intent === "search-categories") {
    return {
      intent: "search-categories",
      categories: await searchCategories(admin, body.query ?? ""),
    };
  }

  if (body.intent === "sync-preview") {
    return {
      intent: "sync-preview",
      syncPreview: await previewSync(admin, shop.id, shop.domain, catalog),
    };
  }
  if (body.intent === "sync-start") {
    const ack = body.acknowledgement;
    const acknowledgement: Acknowledgement = {
      toAdd: Number(ack?.toAdd),
      toRemove: Number(ack?.toRemove),
      confirmed: Array.isArray(ack?.confirmed)
        ? ack.confirmed.filter(
            (kind): kind is Confirmation["kind"] =>
              kind === "large_removal" || kind === "empty_result",
          )
        : [],
    };
    const result = await startSync(
      admin,
      shop.id,
      shop.domain,
      catalog,
      acknowledgement,
    );
    return result.ok
      ? { intent: "sync-start", ok: true }
      : { intent: "sync-start", ok: false, error: result.error };
  }
  if (body.intent === "stop-managing") {
    await stopManaging(catalog.recordId);
    return { intent: "stop-managing", ok: true };
  }

  // Assignment rules only mean anything for a B2B catalog; the page only
  // shows the editor for one, but a posted intent isn't bound by that.
  if (
    (body.intent === "assignment-preview" ||
      body.intent === "assignment-save" ||
      body.intent === "assignment-apply") &&
    catalog.type !== "COMPANY_LOCATION"
  ) {
    throw new Response("Assignment rules are only for B2B catalogs", {
      status: 400,
    });
  }

  if (body.intent === "assignment-save") {
    const assignmentRules = sanitiseAssignmentRules(body.assignmentRules);
    const result = await saveAssignmentRules(
      shop.id,
      catalog.recordId,
      assignmentRules,
    );
    return result.ok
      ? { intent: "assignment-save", ok: true }
      : { intent: "assignment-save", ...result };
  }

  if (body.intent === "assignment-preview") {
    const assignmentRules = sanitiseAssignmentRules(body.assignmentRules);
    const [locations, definitions] = await Promise.all([
      listAssignmentLocations(admin),
      listAssignmentMetafieldDefinitions(admin),
    ]);
    const evaluation = evaluateAssignmentRules(assignmentRules, locations);
    if (!evaluation.ok) {
      return {
        intent: "assignment-preview",
        ok: false,
        errors: evaluation.errors.map((e) => e.error),
      };
    }
    const names = new Map(definitions.map((d) => [d.key, d.name]));
    return {
      intent: "assignment-preview",
      ok: true,
      preview: buildAssignmentPreview({
        locations,
        shopifyCatalogId: catalog.shopifyCatalogId,
        decisions: evaluation.decisions,
        nameFor: (key) => names.get(key),
      }),
    };
  }

  if (body.intent === "assignment-apply") {
    // Always the saved rules, never what the client posts: the button is
    // disabled while there are unsaved edits, and applying should only ever
    // do what's actually saved.
    const [savedRules, locations] = await Promise.all([
      loadAssignmentRules(catalog.recordId),
      listAssignmentLocations(admin),
    ]);
    if (!savedRules) {
      return {
        intent: "assignment-apply",
        ok: false,
        errors: ["Save assignment rules before applying them."],
      };
    }
    const evaluation = evaluateAssignmentRules(savedRules, locations);
    if (!evaluation.ok) {
      return {
        intent: "assignment-apply",
        ok: false,
        errors: evaluation.errors.map((e) => e.error),
      };
    }
    const toAdd = locations
      .filter((location) =>
        isUnassignedMatch(
          location,
          evaluation.decisions.get(location.locationId),
          catalog.shopifyCatalogId,
        ),
      )
      .map((location) => location.locationId);
    const result = await applyAssignments(admin, catalog.shopifyCatalogId, toAdd);
    // A Shopify userError means nothing was applied, so this is a failure,
    // not a success with a side note (the UI only shows the critical "Not
    // applied" banner when ok is false).
    if (result.error) {
      return { intent: "assignment-apply", ok: false, errors: [result.error] };
    }
    return { intent: "assignment-apply", ok: true, added: result.added.length };
  }

  const rules = sanitiseRules(body.rules);

  if (body.intent === "save") {
    const result = await saveRules(shop.id, catalog.recordId, rules);
    return result.ok
      ? { intent: "save", ok: true }
      : { intent: "save", ...result };
  }

  const [products, overrides, current, names] = await Promise.all([
    loadIndexProducts(shop.id),
    loadOverrides(catalog.recordId),
    catalog.publicationId
      ? getCatalogMembership(admin, catalog.publicationId)
      : null,
    // Only the collections and metafields these rules name.
    ruleNames(admin, rules.conditions),
  ]);
  const evaluation = evaluateRuleSet(rules, products, overrides);
  if (!evaluation.ok) {
    return {
      intent: "preview",
      ok: false,
      errors: evaluation.errors.map((e) => e.error),
    };
  }

  return {
    intent: "preview",
    preview: buildPreview({
      products,
      desired: evaluation.productIds,
      decisions: evaluation.decisions,
      current,
      checkVisibility: catalog.type === "COMPANY_LOCATION",
      nameFor: (id) => names.get(id),
    }),
  };
};

function sanitiseMatchMode(value: unknown): MatchMode {
  return value === "ANY" ? "ANY" : "ALL";
}

/** Shared by sanitiseRules and sanitiseAssignmentRules: the fields every
 * condition has, whatever rule set it belongs to. */
function sanitiseConditionFields(c: {
  field?: unknown;
  operator?: unknown;
  value?: unknown;
  metafieldKey?: unknown;
  metafieldType?: unknown;
}) {
  return {
    field: String(c.field ?? ""),
    operator: String(c.operator ?? ""),
    value: c.value === null || c.value === undefined ? null : String(c.value),
    metafieldKey: c.metafieldKey ? String(c.metafieldKey) : null,
    metafieldType: c.metafieldType ? String(c.metafieldType) : null,
  };
}

/** Only accept the shape the page sends. */
function sanitiseRules(input: SavedRules | undefined): SavedRules {
  return {
    includeMatch: sanitiseMatchMode(input?.includeMatch),
    excludeMatch: sanitiseMatchMode(input?.excludeMatch ?? "ANY"),
    conditions: (Array.isArray(input?.conditions) ? input.conditions : []).map(
      (c): RuleCondition => ({
        group: c.group === "EXCLUDE" ? "EXCLUDE" : "INCLUDE",
        ...sanitiseConditionFields(c),
      }),
    ),
  };
}

/** Only accept the shape the page sends. */
function sanitiseAssignmentRules(
  input: SavedAssignmentRules | undefined,
): SavedAssignmentRules {
  return {
    includeMatch: sanitiseMatchMode(input?.includeMatch),
    conditions: (Array.isArray(input?.conditions) ? input.conditions : []).map(
      (c): AssignmentCondition => sanitiseConditionFields(c),
    ),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const BUILDER_FIELDS = Object.keys(FIELDS) as ConditionField[];

interface EditableCondition {
  key: string;
  group: ConditionGroup;
  field: ConditionField;
  operator: ConditionOperator;
  value: string;
  /** Metafield conditions only */
  metafieldKey: string;
  metafieldType: string;
}

/**
 * A unique ID per condition row, so edits go to the right row. Random rather
 * than a counter: a module-level counter restarts at 0 when the module is
 * reloaded (dev hot reload, or an app update) while the page keeps its rows,
 * which gave two rows the same ID and made typing in one change both.
 */
const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function newCondition(
  group: ConditionGroup,
  field: ConditionField = "vendor",
): EditableCondition {
  const definition = FIELDS[field];
  return {
    key: newKey(),
    group,
    field,
    operator: definition.operators[0],
    value: definition.options?.[0].value ?? "",
    metafieldKey: "",
    metafieldType: "",
  };
}

function toEditable(condition: RuleCondition): EditableCondition {
  return {
    key: newKey(),
    group: condition.group,
    field: condition.field as ConditionField,
    operator: condition.operator as ConditionOperator,
    value: condition.value ?? "",
    metafieldKey: condition.metafieldKey ?? "",
    metafieldType: condition.metafieldType ?? "",
  };
}

interface EditorState {
  includeMatch: MatchMode;
  excludeMatch: MatchMode;
  conditions: EditableCondition[];
}

function toSaved(state: EditorState): SavedRules {
  return {
    includeMatch: state.includeMatch,
    excludeMatch: state.excludeMatch,
    conditions: state.conditions.map(
      ({ group, field, operator, value, metafieldKey, metafieldType }) => ({
        group,
        field,
        operator,
        value,
        metafieldKey: field === "metafield" ? metafieldKey : null,
        metafieldType: field === "metafield" ? metafieldType : null,
      }),
    ),
  };
}

interface EditableAssignmentCondition {
  key: string;
  field: AssignmentConditionField;
  operator: ConditionOperator;
  value: string;
  metafieldKey: string;
  metafieldType: string;
}

function newAssignmentCondition(
  field: AssignmentConditionField = "company_metafield",
): EditableAssignmentCondition {
  return {
    key: newKey(),
    field,
    operator: "equals",
    value: "",
    metafieldKey: "",
    metafieldType: "",
  };
}

function toEditableAssignment(
  condition: AssignmentCondition,
): EditableAssignmentCondition {
  return {
    key: newKey(),
    field: isAssignmentField(condition.field)
      ? condition.field
      : "company_metafield",
    operator: condition.operator as ConditionOperator,
    value: condition.value ?? "",
    metafieldKey: condition.metafieldKey ?? "",
    metafieldType: condition.metafieldType ?? "",
  };
}

interface AssignmentEditorState {
  includeMatch: MatchMode;
  conditions: EditableAssignmentCondition[];
}

function toSavedAssignment(
  state: AssignmentEditorState,
): SavedAssignmentRules {
  return {
    includeMatch: state.includeMatch,
    conditions: state.conditions.map(
      ({ field, operator, value, metafieldKey, metafieldType }) => ({
        field,
        operator,
        value,
        metafieldKey: metafieldKey || null,
        metafieldType: metafieldType || null,
      }),
    ),
  };
}

export default function RuleBuilderPage() {
  const {
    catalog,
    rules,
    collections,
    metafieldDefinitions,
    categoryNames: loadedCategoryNames,
    indexedProducts,
    syncStatus,
    hasSavedRules,
    assignmentRules,
    hasSavedAssignmentRules,
    assignmentMetafieldDefinitions,
  } = useLoaderData<typeof loader>();
  const isB2B = catalog.type === "COMPANY_LOCATION";
  // Grows as the merchant searches for and picks categories, seeded with
  // names for whatever the saved rules already use.
  const [categoryNames, setCategoryNames] = useState<Map<string, string>>(
    () => new Map(loadedCategoryNames),
  );
  const { catalogId: catalogParam = "" } = useParams();
  const navigate = useNavigate();
  const previewFetcher = useFetcher<typeof action>();
  const saveFetcher = useFetcher<typeof action>();
  const assignmentPreviewFetcher = useFetcher<typeof action>();
  const assignmentSaveFetcher = useFetcher<typeof action>();
  const assignmentApplyFetcher = useFetcher<typeof action>();

  const [state, setState] = useState<EditorState>(() => ({
    includeMatch: rules.includeMatch,
    excludeMatch: rules.excludeMatch,
    conditions: rules.conditions.map(toEditable),
  }));
  // The rules as last saved, to tell whether there are unsaved changes.
  const [savedJson, setSavedJson] = useState(() =>
    JSON.stringify(toSaved(state)),
  );
  const lastSubmittedSave = useRef(savedJson);

  const saved = useMemo(() => toSaved(state), [state]);
  const savedRulesJson = JSON.stringify(saved);
  const dirty = savedRulesJson !== savedJson;
  const errors = state.conditions.map((c) => validateCondition(c));
  const complete = errors.every((e) => e === null);

  // Live preview: half a second after the last change, once every condition is complete.
  const lastPreviewed = useRef<string | null>(null);
  useEffect(() => {
    if (!complete || lastPreviewed.current === savedRulesJson) return;
    const timer = setTimeout(() => {
      lastPreviewed.current = savedRulesJson;
      previewFetcher.submit({ intent: "preview", rules: saved } as never, {
        method: "post",
        encType: "application/json",
      });
    }, 500);
    return () => clearTimeout(timer);
    // previewFetcher.submit is stable; the rules JSON is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedRulesJson, complete]);

  useEffect(() => {
    if (
      saveFetcher.state === "idle" &&
      saveFetcher.data?.intent === "save" &&
      saveFetcher.data.ok
    ) {
      setSavedJson(lastSubmittedSave.current);
    }
  }, [saveFetcher.state, saveFetcher.data]);

  const update = (key: string, change: Partial<EditableCondition>) =>
    setState((s) => ({
      ...s,
      conditions: s.conditions.map((c) =>
        c.key === key ? { ...c, ...change } : c,
      ),
    }));

  const changeField = (key: string, field: ConditionField) => {
    const fresh = newCondition("INCLUDE", field);
    update(key, {
      field,
      operator: fresh.operator,
      value: fresh.value,
      metafieldKey: "",
      metafieldType: "",
    });
  };

  const previewData = previewFetcher.data;

  // ---------------------------------------------------------------------
  // Assignment rules (B2B catalogs only, Phase 2)
  // ---------------------------------------------------------------------

  const [assignmentState, setAssignmentState] = useState<AssignmentEditorState>(
    () => ({
      includeMatch: assignmentRules.includeMatch,
      conditions: assignmentRules.conditions.map(toEditableAssignment),
    }),
  );
  const [assignmentSavedJson, setAssignmentSavedJson] = useState(() =>
    JSON.stringify(toSavedAssignment(assignmentState)),
  );
  const lastSubmittedAssignmentSave = useRef(assignmentSavedJson);

  const assignmentSaved = useMemo(
    () => toSavedAssignment(assignmentState),
    [assignmentState],
  );
  const assignmentSavedRulesJson = JSON.stringify(assignmentSaved);
  const assignmentDirty = assignmentSavedRulesJson !== assignmentSavedJson;
  const assignmentErrors = assignmentState.conditions.map((c) =>
    validateAssignmentCondition(c),
  );
  const assignmentComplete = assignmentErrors.every((e) => e === null);

  const lastPreviewedAssignment = useRef<string | null>(null);
  useEffect(() => {
    if (
      !isB2B ||
      !assignmentComplete ||
      lastPreviewedAssignment.current === assignmentSavedRulesJson
    )
      return;
    const timer = setTimeout(() => {
      lastPreviewedAssignment.current = assignmentSavedRulesJson;
      assignmentPreviewFetcher.submit(
        { intent: "assignment-preview", assignmentRules: assignmentSaved } as never,
        { method: "post", encType: "application/json" },
      );
    }, 500);
    return () => clearTimeout(timer);
    // assignmentPreviewFetcher.submit is stable; the rules JSON is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentSavedRulesJson, assignmentComplete, isB2B]);

  useEffect(() => {
    if (
      assignmentSaveFetcher.state === "idle" &&
      assignmentSaveFetcher.data?.intent === "assignment-save" &&
      assignmentSaveFetcher.data.ok
    ) {
      setAssignmentSavedJson(lastSubmittedAssignmentSave.current);
    }
  }, [assignmentSaveFetcher.state, assignmentSaveFetcher.data]);

  const updateAssignment = (
    key: string,
    change: Partial<EditableAssignmentCondition>,
  ) =>
    setAssignmentState((s) => ({
      ...s,
      conditions: s.conditions.map((c) =>
        c.key === key ? { ...c, ...change } : c,
      ),
    }));

  const changeAssignmentField = (
    key: string,
    field: AssignmentConditionField,
  ) => {
    const fresh = newAssignmentCondition(field);
    updateAssignment(key, {
      field,
      operator: fresh.operator,
      value: fresh.value,
      metafieldKey: "",
      metafieldType: "",
    });
  };

  const assignmentPreviewData = assignmentPreviewFetcher.data;

  return (
    <s-page heading={`Rules: ${catalog.title}`}>
      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {catalog.type === "COMPANY_LOCATION"
              ? "B2B catalog"
              : "Market catalog"}
            . Products that match the include conditions, and none of the
            exclude conditions, would be in this catalog. Saving stores the
            rules in the app; the catalog in Shopify only changes when you apply
            them below.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button onClick={() => navigate("/app")}>
              Back to catalogs
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <ConditionGroupEditor
        heading="Include products that match"
        group="INCLUDE"
        mode={state.includeMatch}
        onModeChange={(mode) => setState((s) => ({ ...s, includeMatch: mode }))}
        conditions={state.conditions}
        errors={errors}
        collections={collections}
        metafieldDefinitions={metafieldDefinitions}
        categoryNames={categoryNames}
        onCategoryNamed={(id, name) =>
          setCategoryNames((m) => new Map(m).set(id, name))
        }
        onAdd={() =>
          setState((s) => ({
            ...s,
            conditions: [...s.conditions, newCondition("INCLUDE")],
          }))
        }
        onRemove={(key) =>
          setState((s) => ({
            ...s,
            conditions: s.conditions.filter((c) => c.key !== key),
          }))
        }
        onChange={update}
        onFieldChange={changeField}
        emptyText="No include conditions yet, so no products would be in this catalog."
      />

      <ConditionGroupEditor
        heading="Exclude products that match"
        group="EXCLUDE"
        mode={state.excludeMatch}
        onModeChange={(mode) => setState((s) => ({ ...s, excludeMatch: mode }))}
        conditions={state.conditions}
        errors={errors}
        collections={collections}
        metafieldDefinitions={metafieldDefinitions}
        categoryNames={categoryNames}
        onCategoryNamed={(id, name) =>
          setCategoryNames((m) => new Map(m).set(id, name))
        }
        onAdd={() =>
          setState((s) => ({
            ...s,
            conditions: [...s.conditions, newCondition("EXCLUDE")],
          }))
        }
        onRemove={(key) =>
          setState((s) => ({
            ...s,
            conditions: s.conditions.filter((c) => c.key !== key),
          }))
        }
        onChange={update}
        onFieldChange={changeField}
        emptyText="No exclude conditions."
      />

      <s-section heading="Save">
        <s-stack direction="block" gap="base">
          {saveFetcher.data?.intent === "save" && !saveFetcher.data.ok && (
            <s-banner tone="critical" heading="Rules not saved">
              <s-paragraph>{saveFetcher.data.errors.join(" ")}</s-paragraph>
            </s-banner>
          )}
          <s-paragraph>
            {dirty
              ? "You have unsaved changes."
              : hasSavedRules
                ? "These rules are saved."
                : "No rules saved yet. Add conditions, then save them."}
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              disabled={!dirty || !complete}
              onClick={() => {
                lastSubmittedSave.current = savedRulesJson;
                saveFetcher.submit({ intent: "save", rules: saved } as never, {
                  method: "post",
                  encType: "application/json",
                });
              }}
              {...(saveFetcher.state !== "idle" ? { loading: true } : {})}
            >
              Save rules
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <ApplySection
        status={syncStatus}
        dirty={dirty}
        catalogParam={catalogParam}
      />

      <PreviewSection
        isB2B={catalog.type === "COMPANY_LOCATION"}
        indexedProducts={indexedProducts}
        complete={complete}
        loading={previewFetcher.state !== "idle"}
        data={previewData}
      />

      {isB2B && (
        <>
          <s-section heading="Which company locations get this catalog">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Locations that match the conditions get access to this
                catalog. There&apos;s no exclude side: this only ever adds a
                location, it never removes one a merchant assigned by hand or
                that a previous rule run added.
              </s-paragraph>
            </s-stack>
          </s-section>

          <AssignmentConditionGroupEditor
            mode={assignmentState.includeMatch}
            onModeChange={(mode) =>
              setAssignmentState((s) => ({ ...s, includeMatch: mode }))
            }
            conditions={assignmentState.conditions}
            errors={assignmentErrors}
            metafieldDefinitions={assignmentMetafieldDefinitions}
            onAdd={() =>
              setAssignmentState((s) => ({
                ...s,
                conditions: [...s.conditions, newAssignmentCondition()],
              }))
            }
            onRemove={(key) =>
              setAssignmentState((s) => ({
                ...s,
                conditions: s.conditions.filter((c) => c.key !== key),
              }))
            }
            onChange={updateAssignment}
            onFieldChange={changeAssignmentField}
          />

          <s-section heading="Save assignment rules">
            <s-stack direction="block" gap="base">
              {assignmentSaveFetcher.data?.intent === "assignment-save" &&
                !assignmentSaveFetcher.data.ok && (
                  <s-banner tone="critical" heading="Rules not saved">
                    <s-paragraph>
                      {assignmentSaveFetcher.data.errors.join(" ")}
                    </s-paragraph>
                  </s-banner>
                )}
              <s-paragraph>
                {assignmentDirty
                  ? "You have unsaved changes."
                  : hasSavedAssignmentRules
                    ? "These rules are saved."
                    : "No rules saved yet. Add conditions, then save them."}
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  disabled={!assignmentDirty || !assignmentComplete}
                  onClick={() => {
                    lastSubmittedAssignmentSave.current = assignmentSavedRulesJson;
                    assignmentSaveFetcher.submit(
                      {
                        intent: "assignment-save",
                        assignmentRules: assignmentSaved,
                      } as never,
                      { method: "post", encType: "application/json" },
                    );
                  }}
                  {...(assignmentSaveFetcher.state !== "idle"
                    ? { loading: true }
                    : {})}
                >
                  Save assignment rules
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>

          <s-section heading="Apply assignments">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Adds every location the saved rules match to this catalog.
                Additive only: it never removes a location a merchant assigned
                by hand or that a previous apply added, even if it no longer
                matches.
              </s-paragraph>
              {assignmentDirty && (
                <s-paragraph>Save your rules before applying them.</s-paragraph>
              )}
              {assignmentApplyFetcher.data?.intent === "assignment-apply" &&
                !assignmentApplyFetcher.data.ok && (
                  <s-banner tone="critical" heading="Not applied">
                    <s-paragraph>
                      {assignmentApplyFetcher.data.errors.join(" ")}
                    </s-paragraph>
                  </s-banner>
                )}
              {assignmentApplyFetcher.data?.intent === "assignment-apply" &&
                assignmentApplyFetcher.data.ok && (
                  <s-banner
                    tone="success"
                    heading={
                      assignmentApplyFetcher.data.added === 0
                        ? "No locations to add"
                        : `Added ${assignmentApplyFetcher.data.added} location${
                            assignmentApplyFetcher.data.added === 1 ? "" : "s"
                          }`
                    }
                  />
                )}
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  disabled={assignmentDirty || !hasSavedAssignmentRules}
                  onClick={() =>
                    assignmentApplyFetcher.submit(
                      { intent: "assignment-apply" } as never,
                      { method: "post", encType: "application/json" },
                    )
                  }
                  {...(assignmentApplyFetcher.state !== "idle"
                    ? { loading: true }
                    : {})}
                >
                  Apply assignments
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>

          <AssignmentPreviewSection
            complete={assignmentComplete}
            loading={assignmentPreviewFetcher.state !== "idle"}
            data={assignmentPreviewData}
          />
        </>
      )}
    </s-page>
  );
}

/**
 * Apply to Shopify: review what a sync would change, confirm, and watch it
 * run. Uses the saved rules, so unsaved edits have to be saved first.
 */
function ApplySection({
  status,
  dirty,
  catalogParam,
}: {
  status: SyncStatus;
  dirty: boolean;
  /** The catalog's URL param, for the progress route */
  catalogParam: string;
}) {
  const reviewFetcher = useFetcher<typeof action>();
  const startFetcher = useFetcher<typeof action>();
  const stopFetcher = useFetcher<typeof action>();
  const progressFetcher = useFetcher<SyncStatus>();
  const revalidator = useRevalidator();
  const [ticked, setTicked] = useState<Confirmation["kind"][]>([]);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  const running =
    status.latestJob?.status === "RUNNING" ||
    status.latestJob?.status === "QUEUED";
  // While running, show the polled progress; otherwise the page's own data.
  const job = (running && progressFetcher.data?.latestJob) || status.latestJob;
  const progressUrl = `/app/sync-status/${catalogParam}`;

  // While a sync runs, poll the lightweight progress route every two seconds
  // (not the page loader, which queries Shopify).
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => progressFetcher.load(progressUrl), 2000);
    return () => clearInterval(timer);
    // progressFetcher.load is stable enough; running and the URL are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, progressUrl]);

  // When the sync finishes, reload the page once for the final state.
  const polledStatus = progressFetcher.data?.latestJob?.status;
  useEffect(() => {
    if (
      running &&
      polledStatus &&
      polledStatus !== "RUNNING" &&
      polledStatus !== "QUEUED"
    ) {
      revalidator.revalidate();
    }
    // revalidator.revalidate is stable enough; the polled status is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polledStatus, running]);

  const review =
    reviewFetcher.data?.intent === "sync-preview"
      ? reviewFetcher.data.syncPreview
      : null;
  const startError =
    startFetcher.data?.intent === "sync-start" && !startFetcher.data.ok
      ? startFetcher.data.error
      : null;
  const showReview = reviewOpen && review && !running;
  const allTicked =
    review?.confirmations.every((c) => ticked.includes(c.kind)) ?? false;

  const submitReview = () => {
    setTicked([]);
    setReviewOpen(true);
    reviewFetcher.submit({ intent: "sync-preview" } as never, {
      method: "post",
      encType: "application/json",
    });
  };

  return (
    <s-section heading="Apply to Shopify">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          {status.managed
            ? `This catalog is managed: the app keeps its products in line with the rules.${
                status.lastSyncedAt
                  ? ` Last synced ${formatDateTime(status.lastSyncedAt)}.`
                  : ""
              } Until automatic syncing arrives, it changes only when you sync.`
            : "Applying makes the catalog's products match the saved rules, and the catalog becomes managed by the app."}
        </s-paragraph>

        {status.managed && (
          <s-paragraph>
            New products join this catalog when they match the rules. Keep
            &quot;Automatically add new products&quot; off for this catalog in
            Shopify: if it&apos;s on, Shopify adds every new product, and the
            next sync removes the ones that don&apos;t match and turns it off
            again.
          </s-paragraph>
        )}

        <JobStatus job={job} />

        {dirty && (
          <s-paragraph>Save your rules before applying them.</s-paragraph>
        )}

        {!showReview && (
          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              disabled={dirty || running}
              onClick={submitReview}
              {...(reviewFetcher.state !== "idle" ? { loading: true } : {})}
            >
              {status.managed ? "Sync now" : "Review changes"}
            </s-button>
            {status.managed && !confirmingStop && (
              <s-button
                tone="critical"
                disabled={running}
                onClick={() => setConfirmingStop(true)}
              >
                Stop managing
              </s-button>
            )}
          </s-stack>
        )}

        {confirmingStop && (
          <s-banner tone="warning" heading="Stop managing this catalog?">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                The app stops syncing it. Its products stay as they are, and
                auto-publish stays off (turn it on in the Shopify admin if you
                want new products added automatically).
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button
                  tone="critical"
                  onClick={() => {
                    setConfirmingStop(false);
                    stopFetcher.submit({ intent: "stop-managing" } as never, {
                      method: "post",
                      encType: "application/json",
                    });
                  }}
                >
                  Stop managing
                </s-button>
                <s-button onClick={() => setConfirmingStop(false)}>
                  Cancel
                </s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        )}

        {showReview && review.blockers.length > 0 && (
          <s-banner tone="critical" heading="Can't apply yet">
            {review.blockers.map((blocker) => (
              <s-paragraph key={blocker}>{blocker}</s-paragraph>
            ))}
          </s-banner>
        )}

        {showReview && review.blockers.length === 0 && (
          <s-banner
            tone={review.confirmations.length > 0 ? "warning" : "info"}
            heading={
              review.toAdd === 0 &&
              review.toRemove === 0 &&
              !review.createsPublication
                ? "The catalog already matches the rules"
                : `Add ${review.toAdd} and remove ${review.toRemove} products`
            }
          >
            <s-stack direction="block" gap="base">
              <s-paragraph>
                The catalog goes from {review.currentCount} to{" "}
                {review.resultCount} products.
              </s-paragraph>
              {review.createsPublication && (
                <s-paragraph>
                  It has no product list of its own yet, so one is created
                  first, starting with every product.
                </s-paragraph>
              )}
              {(review.turnsOffAutoPublish || review.createsPublication) && (
                <s-paragraph>
                  Auto-publish will be off, so new products only join the
                  catalog when they match the rules.
                </s-paragraph>
              )}
              {review.confirmations.map((confirmation) => (
                <s-checkbox
                  key={confirmation.kind}
                  label={describeConfirmation(confirmation)}
                  checked={ticked.includes(confirmation.kind)}
                  onChange={(event) => {
                    const on = event.currentTarget.checked;
                    setTicked((current) =>
                      on
                        ? [...current, confirmation.kind]
                        : current.filter((kind) => kind !== confirmation.kind),
                    );
                  }}
                />
              ))}
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  disabled={!allTicked}
                  onClick={() => {
                    setReviewOpen(false);
                    startFetcher.submit(
                      {
                        intent: "sync-start",
                        acknowledgement: {
                          toAdd: review.toAdd,
                          toRemove: review.toRemove,
                          confirmed: ticked,
                        },
                      } as never,
                      { method: "post", encType: "application/json" },
                    );
                  }}
                  {...(startFetcher.state !== "idle" ? { loading: true } : {})}
                >
                  Apply changes
                </s-button>
                <s-button onClick={() => setReviewOpen(false)}>Cancel</s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        )}

        {startError && (
          <s-banner tone="critical" heading="Not applied">
            <s-paragraph>{startError}</s-paragraph>
          </s-banner>
        )}
      </s-stack>
    </s-section>
  );
}

function JobStatus({ job }: { job: SyncStatus["latestJob"] }) {
  if (!job) return null;
  const counts = `${job.adds} added, ${job.removes} removed`;
  switch (job.status) {
    case "QUEUED":
    case "RUNNING":
      return (
        <s-banner tone="info" heading="Syncing">
          <s-paragraph>{counts} so far.</s-paragraph>
        </s-banner>
      );
    case "SUCCEEDED":
      return (
        <s-banner
          tone={job.error ? "warning" : "success"}
          heading="Last sync finished"
        >
          <s-paragraph>
            {counts}
            {job.finishedAt ? ` (${formatDateTime(job.finishedAt)})` : ""}.
          </s-paragraph>
          {job.error && <s-paragraph>{job.error}</s-paragraph>}
        </s-banner>
      );
    case "PAUSED":
      return (
        <s-banner
          tone="warning"
          heading="Last sync stopped before making changes"
        >
          <s-paragraph>{job.error}</s-paragraph>
        </s-banner>
      );
    default:
      return (
        <s-banner tone="critical" heading="Last sync failed">
          <s-paragraph>
            {counts} before it stopped. {job.error}
          </s-paragraph>
        </s-banner>
      );
  }
}

function ConditionGroupEditor({
  heading,
  group,
  mode,
  onModeChange,
  conditions,
  errors,
  collections,
  metafieldDefinitions,
  categoryNames,
  onCategoryNamed,
  onAdd,
  onRemove,
  onChange,
  onFieldChange,
  emptyText,
}: {
  heading: string;
  group: ConditionGroup;
  mode: MatchMode;
  onModeChange: (mode: MatchMode) => void;
  conditions: EditableCondition[];
  errors: (string | null)[];
  collections: { id: string; title: string }[];
  metafieldDefinitions: RuleMetafieldDefinition[];
  categoryNames: Map<string, string>;
  onCategoryNamed: (id: string, name: string) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
  onChange: (key: string, change: Partial<EditableCondition>) => void;
  onFieldChange: (key: string, field: ConditionField) => void;
  emptyText: string;
}) {
  const rows = conditions
    .map((condition, index) => ({ condition, error: errors[index] }))
    .filter(({ condition }) => condition.group === group);

  return (
    <s-section heading={heading}>
      <s-stack direction="block" gap="base">
        {rows.length > 1 && (
          <s-select
            label="Products must match"
            value={mode}
            onChange={(event) =>
              onModeChange(event.currentTarget.value === "ANY" ? "ANY" : "ALL")
            }
          >
            <s-option value="ALL">All conditions</s-option>
            <s-option value="ANY">Any condition</s-option>
          </s-select>
        )}

        {rows.length === 0 && <s-paragraph>{emptyText}</s-paragraph>}

        {rows.map(({ condition, error }) => (
          <ConditionRow
            key={condition.key}
            condition={condition}
            error={condition.value.trim() ? error : null}
            collections={collections}
            metafieldDefinitions={metafieldDefinitions}
            categoryNames={categoryNames}
            onCategoryNamed={onCategoryNamed}
            onChange={(change) => onChange(condition.key, change)}
            onFieldChange={(field) => onFieldChange(condition.key, field)}
            onRemove={() => onRemove(condition.key)}
          />
        ))}

        <s-stack direction="inline" gap="base">
          <s-button onClick={onAdd}>Add condition</s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

/**
 * What a dropdown-valued metafield condition starts as, so it never sits
 * empty. Shared by the product and assignment condition rows.
 */
function defaultMetafieldValue(
  chosen: { type: string; choices: string[] | null } | undefined,
): string {
  return chosen && metafieldKind(chosen.type) === "boolean"
    ? "true"
    : (chosen?.choices?.[0] ?? "");
}

function ConditionRow({
  condition,
  error,
  collections,
  metafieldDefinitions,
  categoryNames,
  onCategoryNamed,
  onChange,
  onFieldChange,
  onRemove,
}: {
  condition: EditableCondition;
  error: string | null;
  collections: { id: string; title: string }[];
  metafieldDefinitions: RuleMetafieldDefinition[];
  categoryNames: Map<string, string>;
  onCategoryNamed: (id: string, name: string) => void;
  onChange: (change: Partial<EditableCondition>) => void;
  onFieldChange: (field: ConditionField) => void;
  onRemove: () => void;
}) {
  const definition = FIELDS[condition.field];
  const isMetafield = condition.field === "metafield";
  const metafield = metafieldDefinitions.find(
    (d) => d.key === condition.metafieldKey,
  );
  const operators = operatorsFor(condition.field, condition.metafieldType);
  // Metafield is only offered when the store has product metafield definitions.
  const fields = BUILDER_FIELDS.filter(
    (field) =>
      field !== "metafield" || metafieldDefinitions.length > 0 || isMetafield,
  );

  const chooseMetafield = (key: string) => {
    const chosen = metafieldDefinitions.find((d) => d.key === key);
    if (!chosen) return;
    onChange({
      metafieldKey: chosen.key,
      metafieldType: chosen.type,
      operator: operatorsFor("metafield", chosen.type)[0],
      value: defaultMetafieldValue(chosen),
    });
  };

  const changeOperator = (operator: ConditionOperator) => {
    // "is set" and "is not set" save no value. Switching back to an operator
    // that needs one would leave a dropdown looking chosen but empty, so
    // start it at its first option again.
    const needsDefault =
      isMetafield && operatorTakesValue(operator) && !condition.value.trim();
    onChange(
      needsDefault
        ? { operator, value: defaultMetafieldValue(metafield) }
        : { operator },
    );
  };

  return (
    <s-query-container>
      {/* One row on wide screens, stacked when narrow. Metafield rows have an extra column. */}
      <s-grid
        gridTemplateColumns={
          isMetafield
            ? "@container (inline-size > 640px) 1fr 1.5fr 1fr 1.5fr auto, 1fr"
            : "@container (inline-size > 640px) 1fr 1fr 2fr auto, 1fr"
        }
        gap="base"
        alignItems="center"
      >
        <s-select
          label="Field"
          labelAccessibilityVisibility="exclusive"
          value={condition.field}
          onChange={(event) =>
            onFieldChange(event.currentTarget.value as ConditionField)
          }
        >
          {fields.map((field) => (
            <s-option key={field} value={field}>
              {FIELDS[field].label}
            </s-option>
          ))}
        </s-select>

        {isMetafield && (
          <s-select
            label="Metafield"
            labelAccessibilityVisibility="exclusive"
            placeholder="Choose a metafield"
            value={condition.metafieldKey}
            onChange={(event) => chooseMetafield(event.currentTarget.value)}
          >
            {metafieldDefinitions.map((d) => (
              <s-option key={d.key} value={d.key}>
                {d.name === d.key ? d.key : `${d.name} (${d.key})`}
              </s-option>
            ))}
          </s-select>
        )}

        {/* Shown even with one operator (disabled) so the columns line up. */}
        <s-select
          label="Operator"
          labelAccessibilityVisibility="exclusive"
          value={condition.operator}
          disabled={operators.length <= 1}
          onChange={(event) =>
            changeOperator(event.currentTarget.value as ConditionOperator)
          }
        >
          {operators.map((operator) => (
            <s-option key={operator} value={operator}>
              {operatorLabel(condition.field, operator)}
            </s-option>
          ))}
        </s-select>

        {isMetafield ? (
          <MetafieldValue
            condition={condition}
            metafield={metafield}
            error={error}
            onChange={(value) => onChange({ value })}
          />
        ) : (
          <>
            {definition.valueKind === "text" && (
              <s-text-field
                label="Value"
                labelAccessibilityVisibility="exclusive"
                placeholder={placeholderFor(condition.field)}
                value={condition.value}
                error={error ?? undefined}
                onInput={(event) =>
                  onChange({ value: event.currentTarget.value })
                }
              />
            )}

            {definition.valueKind === "choice" && (
              <s-select
                label="Value"
                labelAccessibilityVisibility="exclusive"
                value={condition.value}
                onChange={(event) =>
                  onChange({ value: event.currentTarget.value })
                }
              >
                {definition.options?.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>
            )}

            {definition.valueKind === "collection" && (
              <s-select
                label="Collection"
                labelAccessibilityVisibility="exclusive"
                placeholder="Choose a collection"
                value={condition.value}
                onChange={(event) =>
                  onChange({ value: event.currentTarget.value })
                }
              >
                {collections.map((collection) => (
                  <s-option key={collection.id} value={collection.id}>
                    {collection.title}
                  </s-option>
                ))}
              </s-select>
            )}

            {definition.valueKind === "category" && (
              <CategoryValue
                value={condition.value}
                name={categoryNames.get(condition.value)}
                onChange={(id, name) => {
                  onCategoryNamed(id, name);
                  onChange({ value: id });
                }}
              />
            )}
          </>
        )}

        <s-button tone="critical" variant="tertiary" onClick={onRemove}>
          Remove
        </s-button>
      </s-grid>
    </s-query-container>
  );
}

/**
 * The value input for a metafield condition: true/false for booleans, the
 * allowed values when the definition limits them, otherwise free text.
 */
function MetafieldValue({
  condition,
  metafield,
  error,
  onChange,
}: {
  condition: Pick<
    EditableCondition,
    "metafieldKey" | "operator" | "value" | "metafieldType"
  >;
  metafield: Pick<RuleMetafieldDefinition, "choices"> | undefined;
  error: string | null;
  onChange: (value: string) => void;
}) {
  // "is set" and "is not set" take no value; keep the grid cell filled.
  if (!condition.metafieldKey || !operatorTakesValue(condition.operator)) {
    return <s-box />;
  }

  const kind = metafieldKind(condition.metafieldType);
  if (kind === "boolean") {
    return (
      <s-select
        label="Value"
        labelAccessibilityVisibility="exclusive"
        value={condition.value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <s-option value="true">True</s-option>
        <s-option value="false">False</s-option>
      </s-select>
    );
  }

  if (metafield?.choices && metafield.choices.length > 0) {
    return (
      <s-select
        label="Value"
        labelAccessibilityVisibility="exclusive"
        placeholder="Choose a value"
        value={condition.value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {metafield.choices.map((choice) => (
          <s-option key={choice} value={choice}>
            {choice}
          </s-option>
        ))}
      </s-select>
    );
  }

  return (
    <s-text-field
      label="Value"
      labelAccessibilityVisibility="exclusive"
      placeholder={kind === "number" ? "e.g. 10" : "Value"}
      value={condition.value}
      error={error ?? undefined}
      onInput={(event) => onChange(event.currentTarget.value)}
    />
  );
}

/**
 * The value input for a category condition: search-as-you-type over
 * Shopify's product taxonomy (thousands of categories, so unlike
 * collections there's no full list to preload), picking from the results.
 */
function CategoryValue({
  value,
  name,
  onChange,
}: {
  value: string;
  /** The selected category's full breadcrumb name, if known */
  name: string | undefined;
  onChange: (id: string, name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const searchFetcher = useFetcher<typeof action>();
  const results =
    query.trim() && searchFetcher.data?.intent === "search-categories"
      ? searchFetcher.data.categories
      : [];

  useEffect(() => {
    if (!query.trim()) return;
    const timer = setTimeout(() => {
      searchFetcher.submit({ intent: "search-categories", query } as never, {
        method: "post",
        encType: "application/json",
      });
    }, 300);
    return () => clearTimeout(timer);
    // searchFetcher.submit is stable; query is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <s-stack direction="block" gap="small-200">
      <s-text-field
        label="Search categories"
        labelAccessibilityVisibility="exclusive"
        placeholder="Search categories, e.g. Snowboards"
        value={query}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      <s-select
        label="Category"
        labelAccessibilityVisibility="exclusive"
        placeholder="Choose a category"
        value={value}
        onChange={(event) => {
          const chosen = results.find(
            (category) => category.id === event.currentTarget.value,
          );
          onChange(event.currentTarget.value, chosen?.fullName ?? name ?? "");
        }}
      >
        {/* Keeps the current selection visible even when it's not (or no
            longer) among the search results. */}
        {value && !results.some((category) => category.id === value) && (
          <s-option value={value}>{name ?? value}</s-option>
        )}
        {results.map((category) => (
          <s-option key={category.id} value={category.id}>
            {category.fullName}
          </s-option>
        ))}
      </s-select>
    </s-stack>
  );
}

function placeholderFor(field: ConditionField): string {
  switch (field) {
    case "tag":
      return "e.g. trade or market:uk";
    case "vendor":
      return "e.g. Driftline";
    case "product_type":
      return "e.g. Snowboard";
    default:
      return "";
  }
}

/**
 * A preview's "Show" dropdown: which of a fixed set of lists to display,
 * remounted whenever the option labels' counts change (`s-select` doesn't
 * redraw its selected label on its own). Shared by the product and
 * assignment preview sections.
 */
function PreviewListSelect<K extends string>({
  value,
  onChange,
  options,
  remountKey,
}: {
  value: K;
  onChange: (value: K) => void;
  options: { value: K; label: string }[];
  remountKey: string;
}) {
  return (
    <s-select
      key={remountKey}
      label="Show"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value as K)}
    >
      {options.map((option) => (
        <s-option key={option.value} value={option.value}>
          {option.label}
        </s-option>
      ))}
    </s-select>
  );
}

interface PreviewTableRow {
  key: string;
  primary: ReactNode;
  inline: ReactNode;
  secondary: ReactNode;
}

/** The rows for whichever list is showing. Shared by both preview sections. */
function PreviewTable({
  rows,
  emptyText,
  headers,
}: {
  rows: PreviewTableRow[];
  emptyText: string;
  headers: [string, string, string];
}) {
  if (rows.length === 0) return <s-paragraph>{emptyText}</s-paragraph>;
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">{headers[0]}</s-table-header>
        <s-table-header listSlot="inline">{headers[1]}</s-table-header>
        <s-table-header listSlot="secondary">{headers[2]}</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {rows.map((row) => (
          <s-table-row key={row.key}>
            <s-table-cell>{row.primary}</s-table-cell>
            <s-table-cell>{row.inline}</s-table-cell>
            <s-table-cell>{row.secondary}</s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

function ShowingCount({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <s-paragraph>
      Showing the first {shown} of {total}.
    </s-paragraph>
  );
}

type ListName = "add" | "remove" | "unchanged";

function PreviewSection({
  isB2B,
  indexedProducts,
  complete,
  loading,
  data,
}: {
  isB2B: boolean;
  indexedProducts: number;
  complete: boolean;
  loading: boolean;
  data: ActionResult | undefined;
}) {
  const [list, setList] = useState<ListName>("add");

  if (!complete) {
    return (
      <s-section heading="Preview">
        <s-paragraph>Finish every condition to see the preview.</s-paragraph>
      </s-section>
    );
  }
  if (!data || data.intent !== "preview") {
    return (
      <s-section heading="Preview">
        <s-paragraph>
          {loading ? "Working out the preview..." : "The preview appears here."}
        </s-paragraph>
      </s-section>
    );
  }
  if (!("preview" in data)) {
    return (
      <s-section heading="Preview">
        <s-banner tone="critical" heading="These rules can't be previewed">
          <s-paragraph>{data.errors.join(" ")}</s-paragraph>
        </s-banner>
      </s-section>
    );
  }

  const preview = data.preview;
  const rows: Record<ListName, PreviewRow[]> = {
    add: preview.addRows,
    remove: preview.removeRows,
    unchanged: preview.unchangedRows,
  };
  const counts: Record<ListName, number> = {
    add: preview.toAdd,
    remove: preview.toRemove,
    unchanged: preview.unchanged,
  };

  return (
    <s-section heading="Preview">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          {preview.inCatalog} of {indexedProducts} indexed products would be in
          this catalog: {preview.toAdd} to add, {preview.toRemove} to remove,{" "}
          {preview.unchanged} unchanged.
          {loading ? " Updating..." : ""}
        </s-paragraph>

        {preview.currentFollowsChannel && (
          <s-banner
            tone="info"
            heading="This catalog has no product list of its own yet"
          >
            <s-paragraph>
              Today it shows every product on its sales channel, so the counts
              compare against all indexed products. Managed mode will create a
              product list for it.
            </s-paragraph>
          </s-banner>
        )}

        {isB2B && preview.notVisible > 0 && (
          <s-banner
            tone="warning"
            heading={`${preview.notVisible} products wouldn't be visible to buyers`}
          >
            <s-paragraph>
              B2B buyers only see products that are in their catalog and
              published to the Online Store. These are marked &quot;Not on
              Online Store&quot; below.
            </s-paragraph>
          </s-banner>
        )}

        <PreviewListSelect
          value={list}
          onChange={setList}
          remountKey={`${preview.toAdd}-${preview.toRemove}-${preview.unchanged}`}
          options={[
            { value: "add", label: `Would be added (${preview.toAdd})` },
            { value: "remove", label: `Would be removed (${preview.toRemove})` },
            { value: "unchanged", label: `Unchanged (${preview.unchanged})` },
          ]}
        />

        <PreviewTable
          emptyText="No products."
          headers={["Product", "Status", "Why"]}
          rows={rows[list].map((row) => ({
            key: row.productId,
            primary: row.title,
            inline: (
              <s-stack direction="inline" gap="small-200">
                {row.status && <s-badge>{titleCase(row.status)}</s-badge>}
                {row.notVisible && (
                  <s-badge tone="warning">Not on Online Store</s-badge>
                )}
              </s-stack>
            ),
            secondary: row.reason,
          }))}
        />
        <ShowingCount shown={rows[list].length} total={counts[list]} />
      </s-stack>
    </s-section>
  );
}

function titleCase(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// ---------------------------------------------------------------------------
// Assignment rules (B2B catalogs only, Phase 2)
// ---------------------------------------------------------------------------

const ASSIGNMENT_FIELD_LABELS: Record<AssignmentConditionField, string> = {
  company_metafield: "Company metafield",
  location_metafield: "Location metafield",
};

function AssignmentConditionGroupEditor({
  mode,
  onModeChange,
  conditions,
  errors,
  metafieldDefinitions,
  onAdd,
  onRemove,
  onChange,
  onFieldChange,
}: {
  mode: MatchMode;
  onModeChange: (mode: MatchMode) => void;
  conditions: EditableAssignmentCondition[];
  errors: (string | null)[];
  metafieldDefinitions: AssignmentMetafieldDefinition[];
  onAdd: () => void;
  onRemove: (key: string) => void;
  onChange: (key: string, change: Partial<EditableAssignmentCondition>) => void;
  onFieldChange: (key: string, field: AssignmentConditionField) => void;
}) {
  return (
    <s-section heading="Assignment conditions">
      <s-stack direction="block" gap="base">
        {conditions.length > 1 && (
          <s-select
            label="Locations must match"
            value={mode}
            onChange={(event) =>
              onModeChange(event.currentTarget.value === "ANY" ? "ANY" : "ALL")
            }
          >
            <s-option value="ALL">All conditions</s-option>
            <s-option value="ANY">Any condition</s-option>
          </s-select>
        )}

        {conditions.length === 0 && (
          <s-paragraph>
            No conditions yet, so no locations would be assigned.
          </s-paragraph>
        )}

        {conditions.map((condition, index) => (
          <AssignmentConditionRow
            key={condition.key}
            condition={condition}
            error={condition.value.trim() ? errors[index] : null}
            metafieldDefinitions={metafieldDefinitions}
            onChange={(change) => onChange(condition.key, change)}
            onFieldChange={(field) => onFieldChange(condition.key, field)}
            onRemove={() => onRemove(condition.key)}
          />
        ))}

        <s-stack direction="inline" gap="base">
          <s-button onClick={onAdd}>Add condition</s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function AssignmentConditionRow({
  condition,
  error,
  metafieldDefinitions,
  onChange,
  onFieldChange,
  onRemove,
}: {
  condition: EditableAssignmentCondition;
  error: string | null;
  metafieldDefinitions: AssignmentMetafieldDefinition[];
  onChange: (change: Partial<EditableAssignmentCondition>) => void;
  onFieldChange: (field: AssignmentConditionField) => void;
  onRemove: () => void;
}) {
  const definitionsForField = metafieldDefinitions.filter(
    (d) => d.field === condition.field,
  );
  const metafield = definitionsForField.find(
    (d) => d.key === condition.metafieldKey,
  );
  const operators = assignmentOperatorsFor(condition.metafieldType);

  const chooseMetafield = (key: string) => {
    const chosen = definitionsForField.find((d) => d.key === key);
    if (!chosen) return;
    onChange({
      metafieldKey: chosen.key,
      metafieldType: chosen.type,
      operator: assignmentOperatorsFor(chosen.type)[0],
      value: defaultMetafieldValue(chosen),
    });
  };

  const changeOperator = (operator: ConditionOperator) => {
    const needsDefault = operatorTakesValue(operator) && !condition.value.trim();
    onChange(
      needsDefault
        ? { operator, value: defaultMetafieldValue(metafield) }
        : { operator },
    );
  };

  return (
    <s-query-container>
      <s-grid
        gridTemplateColumns="@container (inline-size > 640px) 1fr 1.5fr 1fr 1.5fr auto, 1fr"
        gap="base"
        alignItems="center"
      >
        <s-select
          label="Field"
          labelAccessibilityVisibility="exclusive"
          value={condition.field}
          onChange={(event) =>
            onFieldChange(
              event.currentTarget.value as AssignmentConditionField,
            )
          }
        >
          <s-option value="company_metafield">
            {ASSIGNMENT_FIELD_LABELS.company_metafield}
          </s-option>
          <s-option value="location_metafield">
            {ASSIGNMENT_FIELD_LABELS.location_metafield}
          </s-option>
        </s-select>

        <s-select
          label="Metafield"
          labelAccessibilityVisibility="exclusive"
          placeholder="Choose a metafield"
          value={condition.metafieldKey}
          onChange={(event) => chooseMetafield(event.currentTarget.value)}
        >
          {definitionsForField.map((d) => (
            <s-option key={d.key} value={d.key}>
              {d.name === d.key ? d.key : `${d.name} (${d.key})`}
            </s-option>
          ))}
        </s-select>

        <s-select
          label="Operator"
          labelAccessibilityVisibility="exclusive"
          value={condition.operator}
          disabled={operators.length <= 1}
          onChange={(event) =>
            changeOperator(event.currentTarget.value as ConditionOperator)
          }
        >
          {operators.map((operator) => (
            <s-option key={operator} value={operator}>
              {operatorLabel("metafield", operator)}
            </s-option>
          ))}
        </s-select>

        <MetafieldValue
          condition={condition}
          metafield={metafield}
          error={error}
          onChange={(value) => onChange({ value })}
        />

        <s-button tone="critical" variant="tertiary" onClick={onRemove}>
          Remove
        </s-button>
      </s-grid>
    </s-query-container>
  );
}

type AssignmentListName = "add" | "already-assigned" | "not-matched";

function AssignmentPreviewSection({
  complete,
  loading,
  data,
}: {
  complete: boolean;
  loading: boolean;
  data: ActionResult | undefined;
}) {
  const [list, setList] = useState<AssignmentListName>("add");

  if (!complete) {
    return (
      <s-section heading="Assignment preview">
        <s-paragraph>Finish every condition to see the preview.</s-paragraph>
      </s-section>
    );
  }
  if (!data || data.intent !== "assignment-preview") {
    return (
      <s-section heading="Assignment preview">
        <s-paragraph>
          {loading ? "Working out the preview..." : "The preview appears here."}
        </s-paragraph>
      </s-section>
    );
  }
  if (!data.ok) {
    return (
      <s-section heading="Assignment preview">
        <s-banner tone="critical" heading="These rules can't be previewed">
          <s-paragraph>{data.errors.join(" ")}</s-paragraph>
        </s-banner>
      </s-section>
    );
  }

  const preview = data.preview;
  const rows: Record<AssignmentListName, AssignmentPreviewRow[]> = {
    add: preview.addRows,
    "already-assigned": preview.alreadyAssignedRows,
    "not-matched": preview.notMatchedRows,
  };
  const counts: Record<AssignmentListName, number> = {
    add: preview.toAdd,
    "already-assigned": preview.alreadyAssigned,
    "not-matched": preview.notMatched,
  };

  return (
    <s-section heading="Assignment preview">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          {preview.toAdd} location{preview.toAdd === 1 ? "" : "s"} would be
          added, {preview.alreadyAssigned} already{" "}
          {preview.alreadyAssigned === 1 ? "has" : "have"} this catalog,{" "}
          {preview.notMatched} don&apos;t match.
          {loading ? " Updating..." : ""}
        </s-paragraph>

        <PreviewListSelect
          value={list}
          onChange={setList}
          remountKey={`${preview.toAdd}-${preview.alreadyAssigned}-${preview.notMatched}`}
          options={[
            { value: "add", label: `Would be added (${preview.toAdd})` },
            {
              value: "already-assigned",
              label: `Already assigned (${preview.alreadyAssigned})`,
            },
            {
              value: "not-matched",
              label: `Doesn't match (${preview.notMatched})`,
            },
          ]}
        />

        <PreviewTable
          emptyText="No locations."
          headers={["Location", "Company", "Why"]}
          rows={rows[list].map((row) => ({
            key: row.locationId,
            primary: row.name,
            inline: row.companyName,
            secondary: row.reason,
          }))}
        />
        <ShowingCount shown={rows[list].length} total={counts[list]} />
      </s-stack>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
