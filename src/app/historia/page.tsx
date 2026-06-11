import type { Metadata } from "next";
import { ContentPage } from "@/components/store/content-page";
import { createPublicMetadata } from "@/lib/seo";

export const metadata: Metadata = createPublicMetadata({
  title: "Historia | Car Zone Accesorios",
  description: "Conoce la historia de Car Zone Accesorios y su enfoque en el mercado automotriz de Honduras.",
  path: "/historia",
  absoluteTitle: true,
});

export default function HistoriaPage() {
  return (
    <ContentPage
      eyebrow="Historia"
      title="Una tienda creada para vender mejor y atender con orden."
      body="Car Zone Accesorios nace con la idea de unir catálogo, inventario, precios reales, pedidos y facturación en un sistema profesional para el mercado automotriz."
    />
  );
}

