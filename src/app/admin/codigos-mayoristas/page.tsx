import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import { getAdminWholesaleCodes } from "@/services/supabase/admin-wholesale-codes.service";

export const dynamic = "force-dynamic";

const WholesaleCodeManager = nextDynamic(
  () => import("@/components/admin/wholesale-code-manager").then((module) => module.WholesaleCodeManager),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando codigos mayoristas...</div> },
);

export default async function AdminWholesaleCodesPage() {
  await requirePermission("customers:manage");
  const { codes, customers } = await getAdminWholesaleCodes();

  return (
    <AdminShell title="Códigos mayoristas">
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
