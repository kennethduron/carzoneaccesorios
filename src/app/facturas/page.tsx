import { PublicStoreShell } from "@/components/store/public-store-shell";
import { InvoicesList } from "@/components/store/invoices-list";

export default function FacturasPage() {
  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-5xl px-5 py-8">
        <p className="text-sm text-black/50">Facturacion Honduras</p>
        <h1 className="mt-2 text-4xl font-semibold">Facturas</h1>
        <InvoicesList />
      </section>
    </PublicStoreShell>
  );
}
