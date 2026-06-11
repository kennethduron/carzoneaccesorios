import type { Metadata } from "next";
import { Clock, Mail, MapPin, Phone } from "lucide-react";
import { FaWhatsapp } from "react-icons/fa";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { ContactRequestSwitcher } from "@/components/store/contact-request-switcher";
import { SocialLinks, hasSocialLinks } from "@/components/store/social-links";
import { getWholesaleAccessStateAction } from "@/app/actions/wholesale";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";
import { createPublicMetadata } from "@/lib/seo";
import { getPreferredWhatsAppUrl } from "@/utils/contact-settings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = createPublicMetadata({
  title: "Contacto | Car Zone Accesorios Honduras",
  description: "Contacta a Car Zone Accesorios para consultar productos automotrices, compras al detalle y atención mayorista en Honduras.",
  path: "/contacto",
  absoluteTitle: true,
});

export default async function ContactoPage() {
  const [companySettings, wholesaleState] = await Promise.all([getPublicCompanySettings(), getWholesaleAccessStateAction()]);
  const whatsapp = getPreferredWhatsAppUrl(companySettings);
  const contactItems = [
    { Icon: Phone, text: companySettings.customer_service_phone },
    { Icon: Mail, text: companySettings.customer_service_email },
    { Icon: MapPin, text: companySettings.business_address },
    { Icon: Clock, text: companySettings.customer_service_hours },
  ].filter((item) => Boolean(item.text));

  return (
    <PublicStoreShell>
      <section className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="space-y-5">
          <p className="text-sm text-black/50">Contacto</p>
          <h1 className="mt-2 text-4xl font-semibold">Hablemos de tus accesorios</h1>
          <p className="mt-4 max-w-2xl text-black/60">
            Atendemos compras al detalle, talleres, negocios de repuestos y clientes mayoristas.
          </p>
          {contactItems.length > 0 ? (
            <div className="mt-6 grid gap-3">
              {contactItems.map(({ Icon, text }) => (
                <div key={text} className="flex items-center gap-3 rounded-lg border border-black/10 bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
                  <Icon size={18} className="text-[#e4252c]" />
                  <span className="text-sm">{text}</span>
                </div>
              ))}
            </div>
          ) : null}

          {whatsapp ? (
            <a
              href={whatsapp}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-md bg-[#25d366] px-4 py-3 text-sm font-semibold text-white transition-transform hover:scale-[1.01]"
            >
              <FaWhatsapp aria-hidden="true" className="size-[18px]" />
              Contactar por WhatsApp
            </a>
          ) : null}

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
        <ContactRequestSwitcher initialWholesaleState={wholesaleState} />
      </section>
    </PublicStoreShell>
  );
}
