import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { WholesaleCodeManager } from "@/components/admin/wholesale-code-manager";
import { requirePermission } from "@/lib/auth/session";
import { getAdminWholesaleCodes } from "@/services/supabase/admin-wholesale-codes.service";

export const dynamic = "force-dynamic";

export default async function AdminWholesaleCodesPage() {
  await requirePermission("customers:manage");
  const { codes, customers } = await getAdminWholesaleCodes();

  return (
    <AdminShell title="Codigos mayoristas">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <WholesaleCodeManager codes={codes} customers={customers} />
    </AdminShell>
  );
}
