import type { Metadata } from "next";
import { LegalPage } from "@/components/store/legal-page";
import { legalPages } from "@/lib/legal-content";
import { createPublicMetadata } from "@/lib/seo";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = createPublicMetadata({
  title: "Términos y condiciones | Car Zone Accesorios",
  description: "Términos y condiciones de uso, pedidos y compras en Car Zone Accesorios.",
  path: "/terminos-y-condiciones",
  absoluteTitle: true,
});

export default async function TermsPage() {
  const settings = await getPublicCompanySettings();
  const content = legalPages.terms;

  return <LegalPage eyebrow="Legal" title={content.title} intro={content.intro} sections={content.sections} settings={settings} />;
}
