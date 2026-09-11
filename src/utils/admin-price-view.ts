import type { AdminPriceViewMode } from "@/types/admin-price-view";

type AdminDisplayPriceInput = {
  eligible: boolean;
  mode: AdminPriceViewMode;
  retailPrice: number;
  commercialPrice: number;
  adminWholesalePrice?: number | null;
};

export type AdminDisplayPriceKind = "commercial" | "admin-retail" | "admin-wholesale" | "admin-fallback";

export function resolveAdminDisplayPrice({
  eligible,
  mode,
  retailPrice,
  commercialPrice,
  adminWholesalePrice,
}: AdminDisplayPriceInput): { price: number; kind: AdminDisplayPriceKind } {
  if (!eligible) {
    return { price: commercialPrice, kind: "commercial" };
  }

  if (mode === "retail") {
    return { price: retailPrice, kind: "admin-retail" };
  }

  const validWholesalePrice =
    typeof adminWholesalePrice === "number" &&
    Number.isFinite(adminWholesalePrice) &&
    adminWholesalePrice > 0 &&
    adminWholesalePrice <= retailPrice;

  return validWholesalePrice
    ? { price: adminWholesalePrice, kind: "admin-wholesale" }
    : { price: retailPrice, kind: "admin-fallback" };
}
