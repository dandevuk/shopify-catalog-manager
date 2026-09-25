/**
 * Product metafields in the index. Only types that rules can test are kept,
 * and long values are dropped, so the index stays small whatever other apps
 * store in metafields. Keyed by "namespace.key", e.g. "custom.trade_tier".
 */

export interface IndexedMetafield {
  type: string;
  /** As Shopify returns it: text, a number as text, "true"/"false", or a JSON list */
  value: string;
}

export type IndexedMetafields = Record<string, IndexedMetafield>;

/** Metafield types rules can test, and how their values compare. */
export const METAFIELD_TYPES = {
  single_line_text_field: "text",
  multi_line_text_field: "text",
  number_integer: "number",
  number_decimal: "number",
  boolean: "boolean",
  "list.single_line_text_field": "list",
} as const;

export type MetafieldType = keyof typeof METAFIELD_TYPES;
export type MetafieldKind = (typeof METAFIELD_TYPES)[MetafieldType];

/** Longer values (descriptions, rich text) aren't useful in rules. */
export const MAX_METAFIELD_VALUE_LENGTH = 1000;

export function isSupportedMetafieldType(type: string): type is MetafieldType {
  return Object.prototype.hasOwnProperty.call(METAFIELD_TYPES, type);
}

export function metafieldKind(type: string): MetafieldKind | null {
  return isSupportedMetafieldType(type) ? METAFIELD_TYPES[type] : null;
}

/** "custom.trade_tier" style key, as used in the index and in conditions. */
export function metafieldKey(namespace: string, key: string): string {
  return `${namespace}.${key}`;
}

/** Keeps the metafields rules can use. */
export function pickMetafields(
  nodes: {
    namespace: string;
    key: string;
    type: string;
    value: string | null;
  }[],
): IndexedMetafields {
  const picked: IndexedMetafields = {};
  for (const node of nodes) {
    if (!isSupportedMetafieldType(node.type)) continue;
    if (node.value === null || node.value.length > MAX_METAFIELD_VALUE_LENGTH)
      continue;
    picked[metafieldKey(node.namespace, node.key)] = {
      type: node.type,
      value: node.value,
    };
  }
  return picked;
}

/** A list metafield's items, or [] if the value isn't a JSON list of text. */
export function listItems(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
