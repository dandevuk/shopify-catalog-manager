import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../lib/shop.server";
import { fromCatalogParam } from "../lib/shopify/catalog-id";
import {
  FIELDS,
  operatorLabel,
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
import { countProducts } from "../lib/product-index/store.server";
import {
  getCatalogMembership,
  getCollectionNames,
  listCollections,
  loadIndexProducts,
  loadOverrides,
  loadRuleCatalog,
  loadRules,
  saveRules,
  type SavedRules,
} from "../lib/rules/rules.server";

/**
 * Rule builder (preview only): edit a catalog's include and exclude
 * conditions and see which products they'd put in it, compared with what's
 * in it now. Saving stores the rules in the app; nothing changes in Shopify
 * until managed mode (Phase 1, step 4).
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
  const [rules, collections] = await Promise.all([
    loadRules(catalog.recordId),
    listCollections(admin),
  ]);

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
    indexedProducts: await countProducts(shop.id),
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
  if ((actionResult as ActionResult | undefined)?.intent === "preview")
    return false;
  return defaultShouldRevalidate;
};

type ActionResult =
  | { intent: "preview"; preview: Preview }
  | { intent: "save"; ok: true }
  | { intent: "save" | "preview"; ok: false; errors: string[] };

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { admin, shop, catalog } = await loadContext(request, params.catalogId);
  const body = (await request.json()) as {
    intent: "preview" | "save";
    rules: SavedRules;
  };
  const rules = sanitiseRules(body.rules);

  if (body.intent === "save") {
    const result = await saveRules(shop.id, catalog.recordId, rules);
    return result.ok
      ? { intent: "save", ok: true }
      : { intent: "save", ...result };
  }

  const collectionIds = rules.conditions.flatMap((c) =>
    c.field === "in_collection" && c.value ? [c.value] : [],
  );
  const [products, overrides, current, names] = await Promise.all([
    loadIndexProducts(shop.id),
    loadOverrides(catalog.recordId),
    catalog.publicationId
      ? getCatalogMembership(admin, catalog.publicationId)
      : null,
    // Only the collections these rules name, not the picker's full list.
    getCollectionNames(admin, collectionIds),
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

/** Only accept the shape the page sends. */
function sanitiseRules(input: SavedRules | undefined): SavedRules {
  const match = (value: unknown): MatchMode =>
    value === "ANY" ? "ANY" : "ALL";
  return {
    includeMatch: match(input?.includeMatch),
    excludeMatch: match(input?.excludeMatch ?? "ANY"),
    conditions: (Array.isArray(input?.conditions) ? input.conditions : []).map(
      (c): RuleCondition => ({
        group: c.group === "EXCLUDE" ? "EXCLUDE" : "INCLUDE",
        field: String(c.field ?? ""),
        operator: String(c.operator ?? ""),
        value:
          c.value === null || c.value === undefined ? null : String(c.value),
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Category needs a taxonomy picker, so it isn't offered in the builder yet. */
const BUILDER_FIELDS = (Object.keys(FIELDS) as ConditionField[]).filter(
  (f) => f !== "category",
);

interface EditableCondition {
  key: string;
  group: ConditionGroup;
  field: ConditionField;
  operator: ConditionOperator;
  value: string;
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
  };
}

function toEditable(condition: RuleCondition): EditableCondition {
  return {
    key: newKey(),
    group: condition.group,
    field: condition.field as ConditionField,
    operator: condition.operator as ConditionOperator,
    value: condition.value ?? "",
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
    conditions: state.conditions.map(({ group, field, operator, value }) => ({
      group,
      field,
      operator,
      value,
    })),
  };
}

export default function RuleBuilderPage() {
  const { catalog, rules, collections, indexedProducts } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const previewFetcher = useFetcher<typeof action>();
  const saveFetcher = useFetcher<typeof action>();

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
    update(key, { field, operator: fresh.operator, value: fresh.value });
  };

  const previewData = previewFetcher.data;

  return (
    <s-page heading={`Rules: ${catalog.title}`}>
      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {catalog.type === "COMPANY_LOCATION"
              ? "B2B catalog"
              : "Market catalog"}
            . Products that match the include conditions, and none of the
            exclude conditions, would be in this catalog. This is a preview:
            saving stores the rules in the app, but nothing changes in Shopify
            yet.
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
            {dirty ? "You have unsaved changes." : "These rules are saved."}
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

      <PreviewSection
        isB2B={catalog.type === "COMPANY_LOCATION"}
        indexedProducts={indexedProducts}
        complete={complete}
        loading={previewFetcher.state !== "idle"}
        data={previewData}
      />
    </s-page>
  );
}

function ConditionGroupEditor({
  heading,
  group,
  mode,
  onModeChange,
  conditions,
  errors,
  collections,
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

function ConditionRow({
  condition,
  error,
  collections,
  onChange,
  onFieldChange,
  onRemove,
}: {
  condition: EditableCondition;
  error: string | null;
  collections: { id: string; title: string }[];
  onChange: (change: Partial<EditableCondition>) => void;
  onFieldChange: (field: ConditionField) => void;
  onRemove: () => void;
}) {
  const definition = FIELDS[condition.field];

  return (
    <s-query-container>
      {/* One row on wide screens (field, operator, value, remove), stacked when narrow. */}
      <s-grid
        gridTemplateColumns="@container (inline-size > 640px) 1fr 1fr 2fr auto, 1fr"
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
          {BUILDER_FIELDS.map((field) => (
            <s-option key={field} value={field}>
              {FIELDS[field].label}
            </s-option>
          ))}
        </s-select>

        {/* Shown even with one operator (disabled) so the columns line up. */}
        <s-select
          label="Operator"
          labelAccessibilityVisibility="exclusive"
          value={condition.operator}
          disabled={definition.operators.length === 1}
          onChange={(event) =>
            onChange({
              operator: event.currentTarget.value as ConditionOperator,
            })
          }
        >
          {definition.operators.map((operator) => (
            <s-option key={operator} value={operator}>
              {operatorLabel(condition.field, operator)}
            </s-option>
          ))}
        </s-select>

        {definition.valueKind === "text" && (
          <s-text-field
            label="Value"
            labelAccessibilityVisibility="exclusive"
            placeholder={placeholderFor(condition.field)}
            value={condition.value}
            error={error ?? undefined}
            onInput={(event) => onChange({ value: event.currentTarget.value })}
          />
        )}

        {definition.valueKind === "choice" && (
          <s-select
            label="Value"
            labelAccessibilityVisibility="exclusive"
            value={condition.value}
            onChange={(event) => onChange({ value: event.currentTarget.value })}
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
            onChange={(event) => onChange({ value: event.currentTarget.value })}
          >
            {collections.map((collection) => (
              <s-option key={collection.id} value={collection.id}>
                {collection.title}
              </s-option>
            ))}
          </s-select>
        )}

        <s-button tone="critical" variant="tertiary" onClick={onRemove}>
          Remove
        </s-button>
      </s-grid>
    </s-query-container>
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

        <s-select
          // s-select doesn't redraw its selected label when an option's text
          // changes, so remount it whenever the counts change.
          key={`${preview.toAdd}-${preview.toRemove}-${preview.unchanged}`}
          label="Show"
          value={list}
          onChange={(event) => setList(event.currentTarget.value as ListName)}
        >
          <s-option value="add">Would be added ({preview.toAdd})</s-option>
          <s-option value="remove">
            Would be removed ({preview.toRemove})
          </s-option>
          <s-option value="unchanged">Unchanged ({preview.unchanged})</s-option>
        </s-select>

        {rows[list].length === 0 ? (
          <s-paragraph>No products.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
              <s-table-header listSlot="secondary">Why</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows[list].map((row) => (
                <s-table-row key={row.productId}>
                  <s-table-cell>{row.title}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      {row.status && <s-badge>{titleCase(row.status)}</s-badge>}
                      {row.notVisible && (
                        <s-badge tone="warning">Not on Online Store</s-badge>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{row.reason}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {counts[list] > rows[list].length && (
          <s-paragraph>
            Showing the first {rows[list].length} of {counts[list]}.
          </s-paragraph>
        )}
      </s-stack>
    </s-section>
  );
}

function titleCase(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
