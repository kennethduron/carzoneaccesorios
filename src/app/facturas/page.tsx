import { PublicStoreShell } from "@/components/store/public-store-shell";
import { InvoicesList } from "@/components/store/invoices-list";
import { requireSession } from "@/lib/auth/session";
import { getCustomerIssuedInvoices } from "@/services/supabase/customer-account.service";

export const dynamic = "force-dynamic";

export default async function FacturasPage({
  searchParams,
}: {
  searchParams: Promise<{ factura?: string }>;
}) {
  const profile = await requireSession();
  const params = await searchParams;
  const invoices = await getCustomerIssuedInvoices(profile.id, profile.email);

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-5xl px-5 py-8">
        <p className="text-sm text-black/50">Facturacion Honduras</p>
        <h1 className="mt-2 text-4xl font-semibold">Facturas</h1>
        <InvoicesList invoices={invoices} focusInvoice={params.factura} />
      </section>
    </PublicStoreShell>
  );
}
