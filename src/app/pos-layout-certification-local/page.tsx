import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { PosLayoutCertification } from "@/components/admin/pos-layout-certification";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function PosLayoutCertificationPage({ searchParams }: { searchParams: Promise<{ items?: string }> }) {
  if (process.env.NODE_ENV !== "development") notFound();
  const requestedCount = Number((await searchParams).items ?? 20);
  const itemCount = Number.isInteger(requestedCount) ? Math.min(50, Math.max(1, requestedCount)) : 20;

  return (
    <AdminShell title="Punto de Venta" variant="wide" backHref="/admin" backLabel="Volver al inicio">
      <main className="mx-auto w-full px-0 py-1 sm:px-1 lg:px-2">
        <PosLayoutCertification key={itemCount} itemCount={itemCount} />
      </main>
    </AdminShell>
  );
}
