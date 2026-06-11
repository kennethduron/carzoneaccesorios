import type { Metadata } from "next";
import { LegalPage } from "@/components/store/legal-page";
import { legalPages } from "@/lib/legal-content";
import { createPublicMetadata } from "@/lib/seo";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = createPublicMetadata({
  title: "Política de privacidad | Car Zone Accesorios",
  description: "Conoce cómo Car Zone Accesorios trata y protege la información personal de sus clientes.",
  path: "/politica-de-privacidad",
  absoluteTitle: true,
});

export default async function PoliticaDePrivacidadPage() {
  const settings = await getPublicCompanySettings();
  const page = legalPages.privacy;

  return <LegalPage eyebrow="Políticas" title={page.title} intro={page.intro} sections={page.sections} settings={settings} />;
}
