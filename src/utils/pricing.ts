import type { PriceMode, Product } from "@/types/commerce";

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("es-HN", {
    style: "currency",
    currency: "HNL",
    maximumFractionDigits: 2,
  }).format(value);
}

export function getProductPrice(product: Product, mode: PriceMode) {
  return getAuthorizedProductPrice(product, mode);
}

export function hasValidWholesalePrice(product: Pick<Product, "retail_price" | "wholesale_price">) {
  const retailPrice = Number(product.retail_price);
  const wholesalePrice = Number(product.wholesale_price);

  return Number.isFinite(wholesalePrice) && wholesalePrice > 0 && (!Number.isFinite(retailPrice) || wholesalePrice <= retailPrice);
}

export function getAuthorizedProductPrice(product: Pick<Product, "retail_price" | "wholesale_price">, mode: PriceMode) {
  const retailPrice = Number(product.retail_price ?? 0);
  const wholesalePrice = Number(product.wholesale_price ?? 0);

  return mode === "wholesale" && hasValidWholesalePrice({ retail_price: retailPrice, wholesale_price: wholesalePrice })
    ? wholesalePrice
    : retailPrice;
}

export function getProductPriceLabel(product: Product, mode: PriceMode) {
  return mode === "wholesale" && hasValidWholesalePrice(product) ? "Precio mayorista" : "Precio al detalle";
}
