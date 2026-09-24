import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop, updateShopPlan } from "../lib/shop.server";
import { listCatalogs } from "../lib/shopify/catalogs.server";
import type { QueryCost } from "../lib/shopify/graphql.server";
import {
  getShopDiagnostics,
  runPublicationRoundTrip,
  runScopeProbes,
  type ProbeResult,
  type RoundTripResult,
} from "../lib/shopify/diagnostics.server";

/**
 * Diagnostics: spike test 8. Confirms which catalog queries work with the
 * app's scopes, and measures latency and query cost for reads and for
 * publicationUpdate with a real app token.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  await ensureShop(session.shop);

  const shop = await getShopDiagnostics(admin);
  await updateShopPlan(session.shop, { planName: shop.planName, isPlus: shop.isPlus });

  const { catalogs } = await listCatalogs(admin);
  const testableCatalogs = catalogs
    .filter((catalog) => catalog.publicationId)
    .map((catalog) => ({
      title: catalog.title,
      type: catalog.type,
      publicationId: catalog.publicationId as string,
      productCount: catalog.productCount,
    }));

  return {
    shop,
    requestedScopes: (process.env.SCOPES ?? "").split(",").filter(Boolean).sort(),
    testableCatalogs,
  };
};

type ActionResult =
  | { intent: "probes"; probes: ProbeResult[] }
  | { intent: "roundTrip"; publicationId: string; roundTrip: RoundTripResult }
  | { intent: "error"; message: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult> => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "probes") {
    return { intent: "probes", probes: await runScopeProbes(admin) };
  }

  if (intent === "roundTrip") {
    const publicationId = String(form.get("publicationId") ?? "");
    if (!publicationId.startsWith("gid://shopify/Publication/")) {
      return { intent: "error", message: "Choose a catalog to test." };
    }

    // The round trip briefly removes a product from a live catalog, so only
    // allow it on development stores.
    const shop = await getShopDiagnostics(admin);
    if (!shop.isDevelopmentStore) {
      return {
        intent: "error",
        message: "The publicationUpdate test only runs on development stores.",
      };
    }

    return {
      intent: "roundTrip",
      publicationId,
      roundTrip: await runPublicationRoundTrip(admin, publicationId),
    };
  }

  return { intent: "error", message: "Unknown action." };
};

export default function DiagnosticsPage() {
  const { shop, requestedScopes, testableCatalogs } = useLoaderData<typeof loader>();
  const probes = useFetcher<typeof action>();
  const roundTrip = useFetcher<typeof action>();

  const probesBusy = probes.state !== "idle";
  const roundTripBusy = roundTrip.state !== "idle";

  const missingScopes = requestedScopes.filter((scope) => !shop.grantedScopes.includes(scope));

  return (
    <s-page heading="Diagnostics">
      <s-section heading="Store">
        <s-paragraph>
          {shop.name} ({shop.domain}). Plan: {shop.planName}
          {shop.isPlus ? " (Plus features)" : ""}
          {shop.isDevelopmentStore ? ", development store" : ""}.
        </s-paragraph>
      </s-section>

      <s-section heading="Access scopes">
        <s-paragraph>Granted: {shop.grantedScopes.join(", ") || "none"}</s-paragraph>
        {requestedScopes.length > 0 && (
          <s-paragraph>Requested in shopify.app.toml: {requestedScopes.join(", ")}</s-paragraph>
        )}
        {missingScopes.length > 0 && (
          <s-banner tone="warning" heading="Some requested scopes aren't granted yet">
            <s-paragraph>
              Missing: {missingScopes.join(", ")}. Reopen the app from the Shopify admin to
              approve the updated scopes.
            </s-paragraph>
          </s-banner>
        )}
      </s-section>

      <s-section heading="Scope and latency checks">
        <s-paragraph>
          Runs each catalog query the app depends on, one at a time, and reports whether
          it worked, how long it took and its query cost. A failure usually names the
          missing scope.
        </s-paragraph>
        <s-button
          variant="primary"
          onClick={() => probes.submit({ intent: "probes" }, { method: "post" })}
          {...(probesBusy ? { loading: true } : {})}
        >
          Run checks
        </s-button>
        {probes.data?.intent === "probes" && <ProbeTable probes={probes.data.probes} />}
      </s-section>

      <s-section heading="publicationUpdate timing">
        <s-paragraph>
          Removes the first product from the chosen catalog and adds it straight back,
          timing both calls. Development stores only.
        </s-paragraph>
        {testableCatalogs.length === 0 ? (
          <s-paragraph>No catalogs with their own product list to test on.</s-paragraph>
        ) : (
          <s-stack direction="inline" gap="base">
            {testableCatalogs.map((catalog) => (
              <s-button
                key={catalog.publicationId}
                disabled={!shop.isDevelopmentStore || roundTripBusy}
                onClick={() =>
                  roundTrip.submit(
                    { intent: "roundTrip", publicationId: catalog.publicationId },
                    { method: "post" },
                  )
                }
              >
                Test on {catalog.title}
              </s-button>
            ))}
          </s-stack>
        )}
        {roundTrip.data?.intent === "roundTrip" && (
          <RoundTripReport result={roundTrip.data.roundTrip} />
        )}
        {roundTrip.data?.intent === "error" && (
          <s-banner tone="critical" heading="Test not run">
            <s-paragraph>{roundTrip.data.message}</s-paragraph>
          </s-banner>
        )}
      </s-section>
    </s-page>
  );
}

function ProbeTable({ probes }: { probes: ProbeResult[] }) {
  return (
    <s-table>
      <s-table-header-row>
        <s-table-header listSlot="primary">Check</s-table-header>
        <s-table-header listSlot="inline">Result</s-table-header>
        <s-table-header format="numeric">Time (ms)</s-table-header>
        <s-table-header>Cost</s-table-header>
        <s-table-header listSlot="secondary">Details</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {probes.map((probe) => (
          <s-table-row key={probe.key}>
            <s-table-cell>{probe.label}</s-table-cell>
            <s-table-cell>
              <s-badge tone={probe.ok ? "success" : "critical"}>
                {probe.ok ? "Passed" : "Failed"}
              </s-badge>
            </s-table-cell>
            <s-table-cell>{probe.durationMs}</s-table-cell>
            <s-table-cell>{describeCost(probe.cost)}</s-table-cell>
            <s-table-cell>{probe.error ?? probe.purpose}</s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

function RoundTripReport({ result }: { result: RoundTripResult }) {
  if (result.error) {
    return (
      <s-banner tone="warning" heading="Test not run">
        <s-paragraph>{result.error}</s-paragraph>
      </s-banner>
    );
  }

  return (
    <s-stack direction="block" gap="base">
      <s-paragraph>
        Test product: {result.productTitle}. Products in catalog before the test:{" "}
        {result.countBefore ?? "unknown"}.
      </s-paragraph>
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Step</s-table-header>
          <s-table-header listSlot="inline">Result</s-table-header>
          <s-table-header format="numeric">Time (ms)</s-table-header>
          <s-table-header>Cost</s-table-header>
          <s-table-header format="numeric">Products after</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {result.steps.map((step) => (
            <s-table-row key={step.label}>
              <s-table-cell>{step.label}</s-table-cell>
              <s-table-cell>
                <s-badge tone={step.ok ? "success" : "critical"}>
                  {step.ok ? "Passed" : step.error ?? "Failed"}
                </s-badge>
              </s-table-cell>
              <s-table-cell>{step.durationMs}</s-table-cell>
              <s-table-cell>{describeCost(step.cost)}</s-table-cell>
              <s-table-cell>{step.countAfter ?? "unknown"}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-stack>
  );
}

function describeCost(cost: QueryCost | null): string {
  if (!cost) return "n/a";
  const parts: string[] = [];
  if (cost.actualQueryCost !== undefined) parts.push(`actual ${cost.actualQueryCost}`);
  if (cost.requestedQueryCost !== undefined) parts.push(`requested ${cost.requestedQueryCost}`);
  const throttle = cost.throttleStatus;
  if (throttle?.currentlyAvailable !== undefined && throttle.maximumAvailable !== undefined) {
    parts.push(`${throttle.currentlyAvailable}/${throttle.maximumAvailable} left`);
  }
  return parts.join(", ") || "n/a";
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
