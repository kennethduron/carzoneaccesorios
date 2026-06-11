import type { Metadata } from "next";
import { ContentPage } from "@/components/store/content-page";
import { createPublicMetadata } from "@/lib/seo";

export const metadata: Metadata = createPublicMetadata({
  title: "Misión | Car Zone Accesorios",
  description: "La misión de Car Zone Accesorios para atender clientes de productos automotrices en Honduras.",
  path: "/mision",
  absoluteTitle: true,
});

export default function MisionPage() {
  return (
    <ContentPage
      eyebrow="Misión"
      title="Equipar cada vehículo con accesorios confiables y bien seleccionados."
      body="Trabajamos para ofrecer una experiencia de compra clara, inventario organizado y atención cercana para clientes finales, talleres y distribuidores."
    />
  );
}
