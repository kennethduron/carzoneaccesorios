import { LegalPage } from "@/components/store/legal-page";
import { legalPages } from "@/lib/legal-content";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";

export const dynamic = "force-dynamic";

export default async function PoliticaDePrivacidadPage() {
  const settings = await getPublicCompanySettings();
  const page = legalPages.privacy;

  return <LegalPage eyebrow="Políticas" title={page.title} intro={page.intro} sections={page.sections} settings={settings} />;
}
