import prisma from "../db.server";

/**
 * Makes sure there's a Shop record for the current shop, and clears
 * `uninstalledAt` if the app was reinstalled.
 */
export async function ensureShop(domain: string) {
  return prisma.shop.upsert({
    where: { domain },
    create: { domain },
    update: { uninstalledAt: null },
  });
}

/** Non-Plus shops can have up to 3 active B2B catalogs (spike finding 10). */
export const NON_PLUS_B2B_CATALOG_LIMIT = 3;

export async function updateShopPlan(
  domain: string,
  plan: { planName: string; isPlus: boolean },
) {
  return prisma.shop.update({
    where: { domain },
    data: {
      planName: plan.planName,
      isPlus: plan.isPlus,
      b2bCatalogLimit: plan.isPlus ? null : NON_PLUS_B2B_CATALOG_LIMIT,
    },
  });
}
