export const productImageMaxBytes = 3 * 1024 * 1024;
export const productImageMaxMegapixels = 3;
export const productImageMaxPixels = productImageMaxMegapixels * 1_000_000;
export const productImageMaxDisplayDimension = 1600;

export const allowedProductImageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
export const productImageAccept = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

export const productImageHelpText = "Recomendado: imagen JPG, PNG o WEBP, máximo 3 MB y hasta 3 megapíxeles.";
export const productImageTooLargeMessage = "Esta imagen supera el límite permitido. Reduce el peso o resolución antes de subirla.";
export const productImageTooManyPixelsMessage = "Esta imagen supera 3 megapíxeles. Usa una imagen más pequeña.";
export const productImageInvalidFormatMessage = "Formato no permitido. Usa JPG, PNG o WEBP.";
export const productImageGenericLimitMessage = "Esta imagen es demasiado grande. Sube una imagen de máximo 3 MB y hasta 3 megapíxeles.";

export function isAllowedProductImageMimeType(type: string) {
  return allowedProductImageMimeTypes.has(type.toLowerCase());
}

export function formatMegapixels(width: number, height: number) {
  return Math.round((width * height) / 10_000) / 100;
}
