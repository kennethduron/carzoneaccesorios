import type { Metadata } from "next";
import { LegalPage } from "@/components/store/legal-page";
import { legalPages } from "@/lib/legal-content";
import { createPublicMetadata } from "@/lib/seo";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = createPublicMetadata({
  title: "Política de entrega | Car Zone Accesorios",
  description: "Información sobre cobertura, tiempos y condiciones de entrega de pedidos de Car Zone Accesorios.",
  path: "/politica-de-entrega",
  absoluteTitle: true,
});

export default async function PoliticaDeEntregaPage() {
  const settings = await getPublicCompanySettings();
  const page = legalPages.delivery;

  return <LegalPage eyebrow="Políticas" title={page.title} intro={page.intro} sections={page.sections} settings={settings} />;
}
