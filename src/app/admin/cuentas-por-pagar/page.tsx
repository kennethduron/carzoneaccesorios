import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { AccountsPayableImportManager } from "@/components/admin/accounts-payable-import-manager";
import { AccountsPayableManager } from "@/components/admin/accounts-payable-manager";
import { SupplierPaymentAccountingRepairPanel } from "@/components/admin/supplier-payment-accounting-repair-panel";
import { AdminShell } from "@/components/admin/admin-shell";
import { hasEffectivePermission, isTechnicalOwner } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getHistoricalAccountsPayableImportData } from "@/services/supabase/accounts-payable-import.service";
import { getSupplierPaymentAccountingRepairPreviews } from "@/services/accounting/supplier-payment-accounting-repairs";
import { getAdminPayables } from "@/services/supabase/payables.service";
import { getSupplierMultiPaymentConfig, getSupplierMultiPaymentHistory } from "@/services/supabase/supplier-multi-payment.service";
import { getPurchaseOptions } from "@/services/supabase/purchases.service";
import { getSupplierOptions } from "@/services/supabase/suppliers.service";

export const dynamic = "force-dynamic";

export default async function AccountsPayablePage({ searchParams }: { searchParams?: Promise<{ importBatch?: string }> }) {
  const profile = await requirePermission("admin:access");
  const canRead =
    hasEffectivePermission(profile.role, profile.permissions, "payables:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "payables:manage", profile.email);
  const canManage = hasEffectivePermission(profile.role, profile.permissions, "payables:manage", profile.email);
  const canImport = hasEffectivePermission(profile.role, profile.permissions, "payables:import", profile.email);
  const canApply = hasEffectivePermission(profile.role, profile.permissions, "payables:apply", profile.email);
  const canAssign = hasEffectivePermission(profile.role, profile.permissions, "payables:assign", profile.email);
  const canRollback = ["technical_owner", "business_owner"].includes(profile.role) && hasEffectivePermission(profile.role, profile.permissions, "payables:rollback", profile.email);
  const canRepairSupplierPayment =
    isTechnicalOwner(profile.role, profile.email) &&
    hasEffectivePermission(
      profile.role,
      profile.permissions,
      "accounting:repair_supplier_payment",
      profile.email,
    );

  if (!canRead) {
    redirect("/sin-permiso");
  }

  const params = await searchParams;
  const [{ payables, invoices, credits, summary }, suppliers, purchases, importData, repairPreviews, multiPaymentConfig, multiPaymentHistory] = await Promise.all([
    getAdminPayables(),
    getSupplierOptions(true),
    getPurchaseOptions(),
    getHistoricalAccountsPayableImportData({
      batchId: params?.importBatch ?? null,
      canImport,
      canApply,
      canAssign,
      canRollback,
    }),
    getSupplierPaymentAccountingRepairPreviews(),
    getSupplierMultiPaymentConfig(),
    getSupplierMultiPaymentHistory(),
  ]);

  return (
    <AdminShell title="Cuentas por pagar">
      <div className="mb-5">
        <Link href="/admin" className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm">
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <div className="space-y-6">
        <SupplierPaymentAccountingRepairPanel
          previews={repairPreviews}
          canRepair={canRepairSupplierPayment}
        />
        <AccountsPayableImportManager data={importData} />
        <AccountsPayableManager payables={payables} invoices={invoices} credits={credits} suppliers={suppliers} purchases={purchases} summary={summary} canManage={canManage} multiPaymentConfig={multiPaymentConfig} multiPaymentHistory={multiPaymentHistory} />
      </div>
    </AdminShell>
  );
}

