import Link from "next/link";
import type { ReactNode } from "react";
import { Mail, MapPin, Phone } from "lucide-react";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import type { PublicCompanySettings } from "@/types/settings";

export type LegalSection = {
  title: string;
  body: string;
};

export function LegalPage({
  eyebrow,
  title,
  intro,
  sections,
  settings,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  sections: LegalSection[];
  settings: PublicCompanySettings;
}) {
  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-5xl px-5 py-10">
        <p className="text-sm text-black/50">{eyebrow}</p>
        <h1 className="mt-2 text-4xl font-semibold">{title}</h1>
        <p className="mt-4 max-w-3xl text-base leading-7 text-black/65">{intro}</p>

        <div className="mt-6 rounded-lg border border-[#e4252c]/25 bg-[#fff7ed] p-4 text-sm leading-6 text-[#7c2d12]">
          Estos textos son una base operativa para Honduras y pueden ser ajustados por el negocio. Recomendamos revision
          legal y contable antes de publicar cambios contractuales.
        </div>

        <div className="mt-8 grid gap-4">
          {sections.map((section) => (
            <article key={section.title} className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">{section.title}</h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-7 text-black/65">{section.body}</p>
            </article>
          ))}
        </div>

        <BusinessContactCard settings={settings} />
      </section>
    </PublicStoreShell>
  );
}

export function BusinessContactCard({ settings }: { settings: PublicCompanySettings }) {
  return (
    <section className="mt-8 rounded-lg border border-black/10 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Datos del comercio</h2>
          <p className="mt-1 text-sm text-black/55">{settings.trade_name || settings.company_name}</p>
          {settings.legal_business_name ? (
            <p className="mt-1 text-sm text-black/55">Razon social: {settings.legal_business_name}</p>
          ) : null}
          {settings.business_rtn ? <p className="mt-1 text-sm text-black/55">RTN: {settings.business_rtn}</p> : null}
        </div>
        <Link
          href="/contacto-servicio-cliente"
          className="rounded-md bg-[#080808] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#e4252c]"
        >
          Servicio al cliente
        </Link>
      </div>
      <div className="mt-5 grid gap-3 text-sm md:grid-cols-3">
        <Info icon={<MapPin size={17} />} text={settings.business_address || "Honduras"} />
        <Info icon={<Phone size={17} />} text={settings.customer_service_phone || "+504 0000-0000"} />
        <Info icon={<Mail size={17} />} text={settings.customer_service_email || "Correo no configurado"} />
      </div>
      <div className="mt-5 rounded-md bg-[#f4f4f5] p-3 text-sm leading-6 text-black/60">
        Los pagos con tarjeta se coordinan por link externo enviado por WhatsApp. No ingreses datos de tarjeta en esta
        pagina.
      </div>
    </section>
  );
}

function Info({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-[#f4f4f5] px-3 py-2 text-black/65">
      <span className="text-[#e4252c]">{icon}</span>
      <span>{text}</span>
    </div>
  );
}
