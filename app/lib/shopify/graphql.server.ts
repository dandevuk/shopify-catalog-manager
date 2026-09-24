/**
 * Small wrapper around the Admin API client from `authenticate.admin()`.
 *
 * It returns the data together with the request duration and the query cost
 * Shopify reports in `extensions.cost`, which the Diagnostics page uses to
 * measure real latency and throttle cost (spike test 8).
 */

/** The part of the admin context this module needs. */
export interface AdminGraphqlClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<Response>;
}

export interface QueryCost {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: {
    maximumAvailable?: number;
    currentlyAvailable?: number;
    restoreRate?: number;
  };
}

export interface GraphqlResult<T> {
  data: T;
  cost: QueryCost | null;
  durationMs: number;
}

export class GraphqlRequestError extends Error {
  constructor(
    message: string,
    public readonly durationMs: number,
  ) {
    super(message);
    this.name = "GraphqlRequestError";
  }
}

interface RawGraphqlBody<T> {
  data?: T;
  errors?: unknown;
  extensions?: { cost?: QueryCost };
}

export async function runGraphql<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphqlResult<T>> {
  const started = performance.now();
  let body: RawGraphqlBody<T>;

  try {
    const response = await admin.graphql(query, variables ? { variables } : undefined);
    body = (await response.json()) as RawGraphqlBody<T>;
  } catch (error) {
    // The Shopify client throws on top-level GraphQL errors (for example a
    // missing access scope). Surface the message so pages can show it.
    throw new GraphqlRequestError(describeError(error), elapsed(started));
  }

  if (body.errors) {
    throw new GraphqlRequestError(describeError(body.errors), elapsed(started));
  }
  if (!body.data) {
    throw new GraphqlRequestError("The response had no data.", elapsed(started));
  }

  return {
    data: body.data,
    cost: body.extensions?.cost ?? null,
    durationMs: elapsed(started),
  };
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    // GraphqlQueryError from @shopify/shopify-api keeps the response body
    // (with the individual GraphQL error messages) on `body`.
    const withBody = error as Error & { body?: { errors?: unknown } };
    const details = withBody.body?.errors;
    return details ? `${error.message}: ${JSON.stringify(details)}` : error.message;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
