import type { ProductImageInput } from "@/types/products";
import {
  productImageLimitErrorCode,
  productImageMaxCount,
} from "@/utils/product-image-rules";

function cleanText(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nonNegativeInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

export function imagePayload(images: ProductImageInput[]) {
  const validImages = images.filter((image) => cleanText(image.public_url));
  if (validImages.length > productImageMaxCount) {
    throw new Error(productImageLimitErrorCode);
  }

  const selectedPrimaryIndex = validImages.findIndex((image) => image.is_primary);
  const primaryIndex = selectedPrimaryIndex >= 0 ? selectedPrimaryIndex : 0;

  return validImages.map((image, index) => ({
    storage_bucket: "product-images",
    storage_path: cleanText(image.storage_path) ?? cleanText(image.public_id) ?? `products/import-${index}-${Date.now()}`,
    public_id: cleanText(image.public_id) ?? cleanText(image.storage_path),
    public_url: image.public_url.trim(),
    angle: cleanText(image.angle) ?? "principal",
    alt_text: cleanText(image.alt_text),
    sort_order: nonNegativeInteger(image.sort_order, index),
    is_primary: index === primaryIndex,
  }));
}
