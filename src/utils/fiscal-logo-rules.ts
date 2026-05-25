export const fiscalLogoFolder = "car-zone/logos";
export const fiscalLogoMaxBytes = 2 * 1024 * 1024;
export const fiscalLogoMaxMegapixels = 2;
export const fiscalLogoMaxPixels = fiscalLogoMaxMegapixels * 1_000_000;
export const fiscalLogoMaxDisplayWidth = 800;

export const allowedFiscalLogoMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
export const fiscalLogoAccept = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

export const fiscalLogoInvalidFormatMessage = "Formato no permitido. Usa JPG, PNG o WEBP.";
export const fiscalLogoTooLargeMessage = "El logo supera el límite de 2 MB.";
export const fiscalLogoTooManyPixelsMessage =
  "El logo supera el límite permitido. Usa una imagen de máximo 2 megapíxeles.";
export const fiscalLogoSavedMessage = "Logo fiscal actualizado correctamente.";

export function isAllowedFiscalLogoMimeType(type: string) {
  return allowedFiscalLogoMimeTypes.has(type.toLowerCase());
}
