import { LegalPage } from "@/components/store/legal-page";
import { legalPages } from "@/lib/legal-content";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";

export const dynamic = "force-dynamic";

export default async function TermsPage() {
  const settings = await getPublicCompanySettings();
  const content = legalPages.terms;

  return <LegalPage eyebrow="Legal" title={content.title} intro={content.intro} sections={content.sections} settings={settings} />;
}
