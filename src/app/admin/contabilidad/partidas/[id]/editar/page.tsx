import { notFound } from "next/navigation";
import { JournalEntryEditor } from "@/components/admin/journal-entry-editor";
import { requirePermission } from "@/lib/auth/session";
import { getJournalEntryEditData } from "@/services/supabase/accounting.service";

export const dynamic = "force-dynamic";

export default async function EditJournalEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("accounting:edit_draft_entries");
  const { id } = await params;
  const data = await getJournalEntryEditData(id);
  if (!data) notFound();

  return <JournalEntryEditor key={`${data.entry.id}:${data.entry.version}`} data={data} />;
}
