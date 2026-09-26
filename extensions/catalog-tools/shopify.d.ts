import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/index.js' {
  interface SearchCatalogsInput {
    /**
     * Words describing the products or customers the merchant is asking about, e.g. "vip", "wholesale", "snowboards"
     */
    query?: string;
    /**
     * Restrict to Market catalogs or B2B (company location) catalogs
     */
    catalogType?: 'MARKET' | 'COMPANY_LOCATION';
    [k: string]: unknown;
  }

  interface SearchCatalogsOutput {
    /**
     * Catalogs whose rules matched, best match first
     */
    results?: {
      /**
       * The catalog's Shopify GID
       */
      id: string;
      /**
       * MARKET or COMPANY_LOCATION
       */
      type: string;
      /**
       * The catalog's title in Shopify
       */
      title: string;
      /**
       * Plain-English reason this catalog matched
       */
      description: string;
      /**
       * Admin URL to the catalog's rule builder in Smart Catalogs, if available
       */
      url?: string;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  }

  interface DescribeCatalogRulesInput {
    /**
     * The catalog's title, as it appears in the Shopify admin
     */
    catalogTitle: string;
    [k: string]: unknown;
  }

  interface DescribeCatalogRulesOutput {
    /**
     * False when no catalog matched the given title
     */
    found: boolean;
    title?: string;
    /**
     * MARKET or COMPANY_LOCATION
     */
    type?: string;
    /**
     * Admin URL to the catalog's rule builder in Smart Catalogs, if available
     */
    url?: string;
    /**
     * Plain-English description of the catalog's include conditions
     */
    includeRules?: string;
    /**
     * Plain-English description of the catalog's exclude conditions
     */
    excludeRules?: string;
    /**
     * Plain-English description of which B2B company locations are assigned this catalog (COMPANY_LOCATION catalogs only)
     */
    assignmentRules?: string;
    [k: string]: unknown;
  }

  interface ShopifyTools {
    /**
     * Find the merchant's Market or B2B catalogs whose saved Smart Catalogs rules would likely match a described group of products or customers, e.g. 'VIP customers', 'wholesale companies', 'snowboards'. Searches catalog names and saved rule conditions: product tags, vendor, product type, title, category, collection, product metafield values, and for B2B catalogs the company and location metafields that control catalog assignment. Read-only: doesn't create, change, or apply anything.
     */
    register(
      name: 'search_catalogs',
      handler: (
        input: SearchCatalogsInput
      ) => SearchCatalogsOutput | Promise<SearchCatalogsOutput>
    );
    /**
     * Explain in plain language what a specific catalog's saved Smart Catalogs rules currently do, given the catalog's title as it appears in Shopify. Read-only: doesn't create, change, or apply anything.
     */
    register(
      name: 'describe_catalog_rules',
      handler: (
        input: DescribeCatalogRulesInput
      ) => DescribeCatalogRulesOutput | Promise<DescribeCatalogRulesOutput>
    );
  }

  const shopify: import('@shopify/ui-extensions/admin.app.tools.data').Api & {
    tools: ShopifyTools;
  };
  const globalThis: { shopify: typeof shopify };
}
