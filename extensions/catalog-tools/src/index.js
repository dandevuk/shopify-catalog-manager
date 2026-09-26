export default async function extension() {
  shopify.tools.register("search_catalogs", async (input) => {
    const response = await fetch("/api/sidekick/search-catalogs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return response.json();
  });

  shopify.tools.register("describe_catalog_rules", async (input) => {
    const response = await fetch("/api/sidekick/describe-catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return response.json();
  });
}
