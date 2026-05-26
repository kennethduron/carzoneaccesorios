import { PublicStoreShell } from "@/components/store/public-store-shell";
import { InvoicesList } from "@/components/store/invoices-list";
import { requireSession } from "@/lib/auth/session";
import { getCustomerIssuedInvoicesPage } from "@/services/supabase/customer-account.service";

export const dynamic = "force-dynamic";

export default async function FacturasPage({
  searchParams,
}: {
  searchParams: Promise<{ factura?: string; page?: string }>;
}) {
  const profile = await requireSession();
  const params = await searchParams;
  const invoicesPage = await getCustomerIssuedInvoicesPage(profile.id, {
    page: Number(params.page ?? 1),
    pageSize: 20,
  });

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-5xl px-5 py-8">
        <p className="text-sm text-black/50">Facturación Honduras</p>
        <h1 className="mt-2 text-4xl font-semibold">Facturas</h1>
        <InvoicesList
          invoices={invoicesPage.invoices}
          focusInvoice={params.factura}
          page={invoicesPage.page}
          pageSize={invoicesPage.pageSize}
          total={invoicesPage.total}
        />
      </section>
    </PublicStoreShell>
  );
}
