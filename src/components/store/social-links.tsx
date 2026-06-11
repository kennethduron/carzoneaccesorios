import { FaFacebookF, FaInstagram, FaTiktok, FaWhatsapp } from "react-icons/fa";
import type { SocialSettings } from "@/types/settings";

type SocialLinksProps = {
  settings: Partial<SocialSettings> | null | undefined;
  variant?: "footer" | "contact" | "home";
};

const socialItems = [
  { key: "facebook_url", label: "Facebook", icon: FaFacebookF },
  { key: "instagram_url", label: "Instagram", icon: FaInstagram },
  { key: "whatsapp_url", label: "WhatsApp", icon: FaWhatsapp, featured: true },
  { key: "tiktok_url", label: "TikTok", icon: FaTiktok },
] as const;

export function hasSocialLinks(settings: Partial<SocialSettings> | null | undefined) {
  return socialItems.some((item) => Boolean(settings?.[item.key]?.trim()));
}

export function SocialLinks({ settings, variant = "footer" }: SocialLinksProps) {
  const visibleItems = socialItems.filter((item) => Boolean(settings?.[item.key]?.trim()));

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <div className={variant === "home" ? "flex flex-wrap justify-center gap-2 sm:justify-start" : "flex flex-wrap gap-2"}>
      {visibleItems.map((item) => {
        const Icon = item.icon;
        const href = settings?.[item.key]?.trim() ?? "";
        const isFeatured = variant === "contact" && "featured" in item && item.featured;

        return (
          <a
            key={item.key}
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={variant === "footer" ? item.label : `Abrir ${item.label} de Car Zone Accesorios`}
            title={item.label}
            className={`inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2 ${
              isFeatured
                ? "border-[#16803a] bg-[#16803a] text-white hover:-translate-y-0.5 hover:bg-[#126a31]"
                : "border-black/10 bg-white text-[#080808] hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:bg-[#fff1f2]"
            }`}
          >
            <Icon aria-hidden="true" className="size-4" />
            {variant === "footer" ? <span className="sr-only">{item.label}</span> : <span>{item.label}</span>}
          </a>
        );
      })}
    </div>
  );
}
