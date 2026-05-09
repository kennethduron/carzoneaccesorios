import { Mail, MapPin, Phone } from "lucide-react";
import { PublicStoreShell } from "@/components/store/public-store-shell";

export default function ContactoPage() {
  return (
    <PublicStoreShell>
      <section className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[1fr_420px]">
        <div>
          <p className="text-sm text-black/50">Contacto</p>
          <h1 className="mt-2 text-4xl font-semibold">Hablemos de tus accesorios</h1>
          <p className="mt-4 max-w-2xl text-black/60">
            Atendemos compras al detalle, talleres, negocios de repuestos y clientes mayoristas.
          </p>
          <div className="mt-6 grid gap-3">
            {[
              [Phone, "+504 0000-0000"],
              [Mail, "ventas@carzoneaccesorios.com"],
              [MapPin, "Honduras"],
            ].map(([Icon, text]) => (
              <div key={text as string} className="flex items-center gap-3 rounded-lg border border-black/10 bg-white p-4">
                <Icon size={18} className="text-[#246a73]" />
                <span className="text-sm">{text as string}</span>
              </div>
            ))}
          </div>
        </div>
        <form className="rounded-lg border border-black/10 bg-white p-5">
          <div className="grid gap-3">
            <input placeholder="Nombre" className="rounded-md border border-black/10 px-3 py-2 text-sm outline-none" />
            <input placeholder="Correo" className="rounded-md border border-black/10 px-3 py-2 text-sm outline-none" />
            <input placeholder="Telefono" className="rounded-md border border-black/10 px-3 py-2 text-sm outline-none" />
            <textarea placeholder="Mensaje" className="min-h-32 rounded-md border border-black/10 px-3 py-2 text-sm outline-none" />
            <button className="rounded-md bg-[#1c1d1b] px-4 py-3 text-sm font-semibold text-white">Enviar</button>
          </div>
        </form>
      </section>
    </PublicStoreShell>
  );
}
