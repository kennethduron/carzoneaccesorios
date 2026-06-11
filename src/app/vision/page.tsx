import type { Metadata } from "next";
import { ContentPage } from "@/components/store/content-page";
import { createPublicMetadata } from "@/lib/seo";

export const metadata: Metadata = createPublicMetadata({
  title: "Visión | Car Zone Accesorios",
  description: "La visión de Car Zone Accesorios como tienda de accesorios automotrices para Honduras.",
  path: "/vision",
  absoluteTitle: true,
});

export default function VisionPage() {
  return (
    <ContentPage
      eyebrow="Visión"
      title="Ser una referencia regional en accesorios automotrices."
      body="Aspiramos a crecer con tecnología, servicio y procesos comerciales que permitan vender al detalle y al mayoreo con la misma precisión."
    />
  );
}
