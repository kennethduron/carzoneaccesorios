import type { PriceMode, Product } from "@/types/commerce";

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("es-HN", {
    style: "currency",
    currency: "HNL",
    maximumFractionDigits: 2,
  }).format(value);
}

export function getProductPrice(product: Product, mode: PriceMode) {
  return mode === "wholesale" ? product.wholesale_price : product.retail_price;
}
