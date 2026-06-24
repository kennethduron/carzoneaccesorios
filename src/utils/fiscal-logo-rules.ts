export const fiscalLogoFolder = "car-zone/logos";
export const fiscalLogoMaxBytes = 5 * 1024 * 1024;
export const fiscalLogoMaxMegapixels = 5;
export const fiscalLogoMaxPixels = fiscalLogoMaxMegapixels * 1_000_000;
export const fiscalLogoMaxDisplayWidth = 800;

export const allowedFiscalLogoMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
export const fiscalLogoAccept = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

export const fiscalLogoInvalidFormatMessage = "Formato no permitido. Usa PNG, JPG o WEBP.";
export const fiscalLogoTooLargeMessage = "El logo es demasiado grande. Usa una imagen menor a 5MB.";
export const fiscalLogoTooManyPixelsMessage =
  "El logo supera el limite permitido. Usa una imagen de maximo 5 megapixeles.";
export const fiscalLogoSavedMessage = "Logo fiscal actualizado correctamente.";

export function isAllowedFiscalLogoMimeType(type: string) {
  return allowedFiscalLogoMimeTypes.has(type.toLowerCase());
}
