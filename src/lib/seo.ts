import type { Metadata } from "next";

export const siteName = "Car Zone Accesorios";
export const siteUrl = "https://carzoneaccesorios.com";
export const defaultOgImagePath = "/brand/og-car-zone-logo-20260513.png";
export const defaultOgImageUrl = `${siteUrl}${defaultOgImagePath}`;

export function absoluteUrl(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    return defaultOgImageUrl;
  }

  return /^https?:\/\//i.test(normalized) ? normalized : `${siteUrl}${normalized.startsWith("/") ? "" : "/"}${normalized}`;
}

export function serializeJsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function getProductImageAlt(productName: string, currentAlt?: string | null) {
  return currentAlt?.trim() || `${productName} - Car Zone Accesorios Honduras`;
}

type PublicMetadataOptions = {
  title: string;
  description: string;
  path: string;
  image?: string;
  imageAlt?: string;
  absoluteTitle?: boolean;
};

export function createPublicMetadata({
  title,
  description,
  path,
  image = defaultOgImageUrl,
  imageAlt = "Car Zone Accesorios Honduras",
  absoluteTitle = false,
}: PublicMetadataOptions): Metadata {
  const canonical = absoluteUrl(path);
  const resolvedImage = absoluteUrl(image);

  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      locale: "es_HN",
      siteName,
      title,
      description,
      url: canonical,
      images: [{ url: resolvedImage, width: 1200, height: 630, alt: imageAlt }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: resolvedImage, alt: imageAlt }],
    },
  };
}

export function createNoIndexMetadata(title: string, description?: string): Metadata {
  return {
    title,
    description,
    robots: {
      index: false,
      follow: false,
      googleBot: {
        index: false,
        follow: false,
      },
    },
  };
}
