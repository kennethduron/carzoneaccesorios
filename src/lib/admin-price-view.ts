import type { AppRole } from "@/types/auth";
import type { AdminPriceViewMode } from "@/types/admin-price-view";

export const adminPriceViewRoles = ["technical_owner", "business_owner", "admin"] as const satisfies readonly AppRole[];
export const ADMIN_PRICE_VIEW_MAX_PRODUCT_IDS = 48;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function canUseAdminPriceView(role: AppRole | null | undefined) {
  return Boolean(role && adminPriceViewRoles.includes(role as (typeof adminPriceViewRoles)[number]));
}

export function isAdminPriceViewMode(value: unknown): value is AdminPriceViewMode {
  return value === "retail" || value === "wholesale";
}

export function adminPriceViewCookieName(userId: string) {
  if (!uuidPattern.test(userId)) {
    throw new Error("Invalid user id for admin price view preference.");
  }

  return `cz-admin-price-view-${userId.toLowerCase()}`;
}

export function normalizeAdminPriceViewProductIds(productIds: readonly string[]) {
  if (productIds.length > ADMIN_PRICE_VIEW_MAX_PRODUCT_IDS) {
    throw new Error(`Admin price view accepts at most ${ADMIN_PRICE_VIEW_MAX_PRODUCT_IDS} product ids.`);
  }

  const normalized = Array.from(new Set(productIds.map((productId) => productId.trim().toLowerCase())));
  if (normalized.some((productId) => !uuidPattern.test(productId))) {
    throw new Error("Invalid product id for admin price view.");
  }

  return normalized;
}
