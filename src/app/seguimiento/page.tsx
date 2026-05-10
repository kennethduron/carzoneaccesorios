import { PublicStoreShell } from "@/components/store/public-store-shell";
import { OrderTracking } from "@/components/store/order-tracking";

export default function SeguimientoPage() {
  return (
    <PublicStoreShell>
      <section className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[1fr_420px]">
        <div>
          <p className="text-sm text-black/50">Seguimiento de pedido</p>
          <h1 className="mt-2 text-4xl font-semibold">Consulta el estado de tu compra</h1>
          <p className="mt-4 max-w-2xl text-black/60">
            Ingresa tu número de pedido para consultar preparacion, despacho y entrega.
          </p>
        </div>
        <OrderTracking />
      </section>
    </PublicStoreShell>
  );
}
