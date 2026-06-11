import type { Metadata } from "next";
import { LegalPage } from "@/components/store/legal-page";
import { legalPages } from "@/lib/legal-content";
import { createPublicMetadata } from "@/lib/seo";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = createPublicMetadata({
  title: "Política de cancelación | Car Zone Accesorios",
  description: "Consulta las condiciones de cancelación de pedidos en Car Zone Accesorios.",
  path: "/politica-de-cancelacion",
  absoluteTitle: true,
});

export default async function PoliticaDeCancelacionPage() {
  const settings = await getPublicCompanySettings();
  const page = legalPages.cancellation;

  return <LegalPage eyebrow="Políticas" title={page.title} intro={page.intro} sections={page.sections} settings={settings} />;
}
