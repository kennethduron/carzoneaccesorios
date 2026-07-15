import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { CustomerPortalLinkWorkspace } from "@/components/admin/customer-portal-link-workspace";
import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function CustomerPortalLinkPage() {
  await requirePermission("customers:link_portal_account");

  return (
    <AdminShell title="Vincular cuenta web">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <CustomerPortalLinkWorkspace />
    </AdminShell>
  );
}
