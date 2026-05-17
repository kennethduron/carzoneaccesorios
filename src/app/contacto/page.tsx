import { Mail, MapPin, Phone } from "lucide-react";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { ContactRequestSwitcher } from "@/components/store/contact-request-switcher";
import { SocialLinks, hasSocialLinks } from "@/components/store/social-links";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";

export const dynamic = "force-dynamic";

export default async function ContactoPage() {
  const companySettings = await getPublicCompanySettings();

  return (
    <PublicStoreShell>
      <section className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="space-y-5">
          <p className="text-sm text-black/50">Contacto</p>
          <h1 className="mt-2 text-4xl font-semibold">Hablemos de tus accesorios</h1>
          <p className="mt-4 max-w-2xl text-black/60">
            Atendemos compras al detalle, talleres, negocios de repuestos y clientes mayoristas.
          </p>
          <div className="mt-6 grid gap-3">
            {[
              [Phone, companySettings.customer_service_phone || "+504 0000-0000"],
              [Mail, companySettings.customer_service_email || "ventas@carzoneaccesorios.com"],
              [MapPin, companySettings.business_address || "Honduras"],
            ].map(([Icon, text]) => (
              <div key={text as string} className="flex items-center gap-3 rounded-lg border border-black/10 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
                <Icon size={18} className="text-[#e4252c]" />
                <span className="text-sm">{text as string}</span>
              </div>
            ))}
          </div>

          {hasSocialLinks(companySettings) ? (
            <section className="rounded-lg border border-black/10 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
              <h2 className="font-semibold">También puedes contactarnos</h2>
              <p className="mt-2 text-sm text-black/55">WhatsApp es el canal más rápido para consultas de pedidos y mayoreo.</p>
              <div className="mt-4">
                <SocialLinks settings={companySettings} variant="contact" />
              </div>
            </section>
          ) : null}
        </div>
        <ContactRequestSwitcher />
      </section>
    </PublicStoreShell>
  );
}
