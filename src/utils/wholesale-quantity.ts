import type { PriceMode, Product } from "@/types/commerce";
import { hasValidWholesalePrice } from "@/utils/pricing";

export function getWholesaleMinimumQuantity(product: Pick<Product, "wholesale_min_quantity">) {
  const minimum = Math.trunc(Number(product.wholesale_min_quantity ?? 1));
  return Number.isFinite(minimum) && minimum > 1 ? minimum : 1;
}

export function requiresWholesaleMinimumQuantity(
  product: Pick<Product, "retail_price" | "wholesale_price" | "wholesale_min_quantity">,
  priceMode: PriceMode,
) {
  return priceMode === "wholesale" && hasValidWholesalePrice(product) && getWholesaleMinimumQuantity(product) > 1;
}

export function wholesaleMinimumQuantityMessage(minimumQuantity: number) {
  return `Este producto requiere una compra mínima de ${minimumQuantity} unidades para precio mayorista.`;
}
