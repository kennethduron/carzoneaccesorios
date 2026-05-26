import type { PriceMode, Product } from "@/types/commerce";

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("es-HN", {
    style: "currency",
    currency: "HNL",
    maximumFractionDigits: 2,
  }).format(value);
}

export function getProductPrice(product: Product, mode: PriceMode) {
  return mode === "wholesale" && hasValidWholesalePrice(product) ? product.wholesale_price : product.retail_price;
}

export function hasValidWholesalePrice(product: Pick<Product, "retail_price" | "wholesale_price">) {
  return product.wholesale_price > 0 && product.wholesale_price < product.retail_price;
}

export function getProductPriceLabel(product: Product, mode: PriceMode) {
  return mode === "wholesale" && hasValidWholesalePrice(product) ? "Precio mayorista" : "Precio al detalle";
}
