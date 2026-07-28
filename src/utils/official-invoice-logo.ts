export const officialInvoiceLogoFallbackPath = "/brand/car-zone-logo-nav.png";

const legacyOfficialInvoiceLogoUrls = new Set([
  "https://res.cloudinary.com/dobhntpan/image/upload/v1781961845/car-zone/logos/fiscal-logo-1781961845119-5c650659.webp",
]);

const legacyOfficialInvoiceLogoPaths = new Set([
  "/brand/car-zone-logo.jpeg",
]);

const legacyOfficialInvoiceLogoFileNames = new Set([
  "fiscal-logo-1779667712816-e5d6974a.webp",
  "fiscal-logo-1781961845119-5c650659.webp",
]);

export const officialInvoiceLogoLayout = {
  maxWidthMm: 100,
  maxHeightMm: 32,
  htmlMarginTopMm: 2,
  htmlMarginBottomMm: 8,
  mobileMaxHeightPx: 96,
  pdfX: 12,
  pdfY: 14,
  pdfCompanyNameY: 60,
  pdfCompanyLinesY: 65,
  pdfInvoiceBoxX: 130,
  pdfInvoiceBoxWidth: 52,
  pdfMinimumGap: 10,
} as const;

function logoFileName(source: string) {
  try {
    const parsed = new URL(source, "https://carzoneaccesorios.com");
    return parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
  } catch {
    return "";
  }
}

/**
 * Historical invoices keep their original company_logo_url snapshot. Only the
 * known square sources below are substituted at render time so their embedded
 * white canvas does not shrink the visible Car Zone artwork.
 */
export function isKnownLegacyOfficialInvoiceLogoSource(source: string) {
  const normalized = source.trim();
  if (!normalized) return false;

  return (
    legacyOfficialInvoiceLogoUrls.has(normalized) ||
    legacyOfficialInvoiceLogoPaths.has(normalized) ||
    legacyOfficialInvoiceLogoFileNames.has(logoFileName(normalized))
  );
}

export function resolveOfficialInvoiceLogoSrc(source: string | null | undefined) {
  const normalized = source?.trim();
  if (!normalized || isKnownLegacyOfficialInvoiceLogoSource(normalized)) {
    return officialInvoiceLogoFallbackPath;
  }

  return normalized;
}
