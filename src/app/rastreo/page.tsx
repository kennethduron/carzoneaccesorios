import type { Metadata } from "next";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { PublicOrderTracking } from "@/components/store/public-order-tracking";
import { createPublicMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = createPublicMetadata({
  title: "Rastreo de pedidos | Car Zone Accesorios",
  description: "Consulta de forma segura el estado de tu pedido de Car Zone Accesorios.",
  path: "/rastreo",
  absoluteTitle: true,
});

export default async function RastreoPage({
  searchParams,
}: {
  searchParams: Promise<{ codigo?: string }>;
}) {
  const params = await searchParams;

  return (
    <PublicStoreShell>
      <section className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[1fr_460px]">
        <div>
          <p className="text-sm text-black/50">Rastreo de pedido</p>
          <h1 className="mt-2 text-4xl font-semibold">Consulta el estado de tu compra</h1>
          <p className="mt-4 max-w-2xl text-black/60">
            Ingresa tu código de seguimiento para ver el estado del pedido, pago y despacho sin iniciar sesión.
          </p>
          <p className="mt-4 max-w-2xl rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">
            Por seguridad no mostramos RTN completo, dirección completa, comprobantes ni notas internas.
          </p>
        </div>
        <PublicOrderTracking initialCode={params.codigo ?? ""} />
      </section>
    </PublicStoreShell>
  );
}


