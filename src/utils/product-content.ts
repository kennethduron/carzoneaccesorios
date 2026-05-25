import type { Product } from "@/types/commerce";

export const productShortDescriptionMaxLength = 160;

export function normalizeProductText(value: string | null | undefined) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function truncateProductText(value: string | null | undefined, maxLength = productShortDescriptionMaxLength) {
  const text = normalizeProductText(value);

  if (text.length <= maxLength) {
    return text;
  }

  const clipped = text.slice(0, maxLength - 1).trimEnd();
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > 80 ? lastSpace : clipped.length).trimEnd()}...`;
}

export function getProductCardDescription(product: Pick<Product, "short_description" | "description">) {
  return product.short_description?.trim() || truncateProductText(product.description);
}

export function getProductMetaDescription(product: Pick<Product, "name" | "short_description" | "description">) {
  return getProductCardDescription(product) || `${product.name} disponible en Car Zone Accesorios.`;
}

export function parseProductLines(value: string | null | undefined) {
  return String(value ?? "")
    .split(/\r?\n|[;•]/)
    .map((line) => line.trim())
    .filter(Boolean);
}
