import { notFound } from "next/navigation";
import { JournalEntryPrintDocument } from "@/components/admin/journal-entry-print-document";
import { requirePermission } from "@/lib/auth/session";
import { getJournalEntryByIdForViewer } from "@/services/supabase/accounting.service";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";
import { uuidLike } from "@/utils/validation";

export const dynamic = "force-dynamic";

export default async function PrintJournalEntryPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("accounting:read");
  const { id } = await params;
  const journalEntryId = uuidLike(id, "ID de partida contable");
  if (!journalEntryId.ok) notFound();

  const [data, company] = await Promise.all([
    getJournalEntryByIdForViewer(journalEntryId.value),
    getPublicCompanySettings(),
  ]);
  if (!data) notFound();

  return <JournalEntryPrintDocument data={data} company={company} />;
}
