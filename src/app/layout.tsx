import type { Metadata, Viewport } from "next";
import { Rajdhani, Titillium_Web } from "next/font/google";
import { AppProviders } from "@/components/providers/app-providers";
import "./globals.css";

const siteUrl = "https://carzoneaccesorios.vercel.app";
const ogImagePath = "/brand/og-car-zone-logo-20260513.png";
const ogImageUrl = `${siteUrl}${ogImagePath}`;

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
    default: "Car Zone Accesorios | Accesorios automotrices",
    template: "%s | Car Zone Accesorios",
  },
  description:
    "Tienda automotriz de accesorios, repuestos y productos para vehículos con venta al detalle, cuentas mayoristas, pedidos, rastreo y facturación.",
  keywords: [
    "Car Zone Accesorios",
    "accesorios automotrices Honduras",
    "accesorios para vehículos",
    "tienda automotriz",
    "mayoreo automotriz",
    "repuestos y accesorios",
  ],
  applicationName: "Car Zone Accesorios",
  authors: [{ name: "Car Zone Accesorios" }],
  creator: "Car Zone Accesorios",
  publisher: "Car Zone Accesorios",
  alternates: {
    canonical: siteUrl,
  },
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.png", type: "image/png", sizes: "256x256" },
      { url: "/brand/car-zone-logo.jpeg", type: "image/jpeg" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: ["/favicon.png"],
  },
  openGraph: {
    type: "website",
    locale: "es_HN",
    url: siteUrl,
    siteName: "Car Zone Accesorios",
    title: "Car Zone Accesorios | Accesorios automotrices",
    description:
      "Accesorios automotrices con experiencia de compra al detalle, mayorista, rastreo de pedidos y atención profesional.",
    images: [
      {
        url: ogImageUrl,
        width: 1200,
        height: 630,
        type: "image/png",
        alt: "Logo oficial completo de Car Zone Accesorios.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Car Zone Accesorios | Accesorios automotrices",
    description: "Tienda automotriz con venta al detalle, mayorista y rastreo de pedidos.",
    images: {
      url: ogImageUrl,
      alt: "Logo oficial completo de Car Zone Accesorios.",
    },
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
