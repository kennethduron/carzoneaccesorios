import type { Metadata, Viewport } from "next";
import { Rajdhani, Titillium_Web } from "next/font/google";
import { AppProviders } from "@/components/providers/app-providers";
import { defaultOgImageUrl, siteName, siteUrl } from "@/lib/seo";
import "./globals.css";

const rajdhani = Rajdhani({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-brand",
  display: "swap",
});

const titillium = Titillium_Web({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-copy",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Car Zone Accesorios | Accesorios automotrices en Honduras",
    template: `%s | ${siteName}`,
  },
  description:
    "Accesorios para carros, repuestos, audio, luces LED y seguridad vehicular disponibles en Honduras con atención personalizada.",
  keywords: [
    "Car Zone Accesorios",
    "accesorios automotrices Honduras",
    "accesorios para vehículos",
    "tienda automotriz",
    "mayoreo automotriz",
    "repuestos y accesorios",
  ],
  applicationName: siteName,
  authors: [{ name: siteName }],
  creator: siteName,
  publisher: siteName,
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/icon.png", type: "image/png", sizes: "256x256" },
      { url: "/favicon.png", type: "image/png", sizes: "256x256" },
    ],
    apple: [
      { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
    shortcut: ["/favicon.png"],
  },
  openGraph: {
    type: "website",
    locale: "es_HN",
    url: siteUrl,
    siteName,
    title: "Car Zone Accesorios | Accesorios automotrices en Honduras",
    description:
      "Compra accesorios para carros, audio, luces LED, seguridad vehicular y productos automotrices en Honduras.",
    images: [
      {
        url: defaultOgImageUrl,
        width: 1200,
        height: 630,
        type: "image/png",
        alt: "Car Zone Accesorios Honduras",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Car Zone Accesorios | Accesorios automotrices en Honduras",
    description: "Accesorios para carros y productos automotrices disponibles en Honduras.",
    images: [{ url: defaultOgImageUrl, alt: "Car Zone Accesorios Honduras" }],
  },
  category: "automotive ecommerce",
};

export const viewport: Viewport = {
  themeColor: "#E4252C",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={`${rajdhani.variable} ${titillium.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
