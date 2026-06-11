import type { ContactSettingsInput, PublicCompanySettings } from "@/types/settings";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const socialHosts = {
  facebook_url: ["facebook.com", "fb.com"],
  instagram_url: ["instagram.com"],
  tiktok_url: ["tiktok.com"],
} as const;

function cleanHost(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function isAllowedHost(hostname: string, allowedHosts: readonly string[]) {
  const host = cleanHost(hostname);
  return allowedHosts.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`));
}

function normalizeSocialUrl(label: string, value: string, allowedHosts: readonly string[]) {
  const cleanValue = value.trim();
  if (!cleanValue) {
    return "";
  }

  let url: URL;
  try {
    url = new URL(cleanValue);
  } catch {
    throw new Error(`${label} debe ser una URL válida.`);
  }

  if (!["http:", "https:"].includes(url.protocol) || !isAllowedHost(url.hostname, allowedHosts)) {
    throw new Error(`${label} debe usar una URL oficial de ${label}.`);
  }

  return url.toString();
}

function normalizeHondurasDigits(value: string, label: string) {
  const digits = value.replace(/\D/g, "");
  const normalized = digits.length === 8 ? `504${digits}` : digits;

  if (normalized.length !== 11 || !normalized.startsWith("504")) {
    throw new Error(`${label} debe ser un número hondureño de 8 dígitos, con o sin +504.`);
  }

  return normalized;
}

export function normalizeWhatsAppUrl(value: string) {
  const cleanValue = value.trim();
  if (!cleanValue) {
    return "";
  }

  if (/^https?:\/\//i.test(cleanValue)) {
    let url: URL;
    try {
      url = new URL(cleanValue);
    } catch {
      throw new Error("WhatsApp debe ser un enlace o número válido.");
    }

    const host = cleanHost(url.hostname);
    let phone = "";

    if (host === "wa.me") {
      phone = url.pathname.split("/").filter(Boolean)[0] ?? "";
    } else if (host === "api.whatsapp.com" && url.pathname.replace(/\/+$/, "") === "/send") {
      phone = url.searchParams.get("phone") ?? "";
    } else {
      throw new Error("WhatsApp debe usar wa.me o api.whatsapp.com.");
    }

    return `https://wa.me/${normalizeHondurasDigits(phone, "WhatsApp")}`;
  }

  if (!/^[+\d\s()-]+$/.test(cleanValue)) {
    throw new Error("WhatsApp debe ser un enlace o número válido.");
  }

  return `https://wa.me/${normalizeHondurasDigits(cleanValue, "WhatsApp")}`;
}

export function validateHondurasPhone(value: string) {
  const cleanValue = value.trim();
  if (!cleanValue) {
    return "";
  }

  if (!/^[+\d\s()-]+$/.test(cleanValue)) {
    throw new Error("El teléfono contiene caracteres no válidos.");
  }

  normalizeHondurasDigits(cleanValue, "El teléfono");
  return cleanValue;
}

export function sanitizeContactSettings(input: ContactSettingsInput): ContactSettingsInput {
  const email = input.customer_service_email.trim();
  if (email && !emailPattern.test(email)) {
    throw new Error("El correo electrónico no es válido.");
  }

  return {
    facebook_url: normalizeSocialUrl("Facebook", input.facebook_url, socialHosts.facebook_url),
    instagram_url: normalizeSocialUrl("Instagram", input.instagram_url, socialHosts.instagram_url),
    tiktok_url: normalizeSocialUrl("TikTok", input.tiktok_url, socialHosts.tiktok_url),
    whatsapp_url: normalizeWhatsAppUrl(input.whatsapp_url),
    customer_service_whatsapp: normalizeWhatsAppUrl(input.customer_service_whatsapp),
    customer_service_phone: validateHondurasPhone(input.customer_service_phone),
    customer_service_email: email,
    business_address: input.business_address.trim(),
    customer_service_hours: input.customer_service_hours.trim(),
  };
}

export function getPreferredWhatsAppUrl(
  settings:
    | Pick<PublicCompanySettings, "customer_service_whatsapp" | "whatsapp_url">
    | { customer_service_whatsapp?: string | null; whatsapp_url?: string | null }
    | null
    | undefined,
) {
  return settings?.customer_service_whatsapp?.trim() || settings?.whatsapp_url?.trim() || "";
}

export function buildWhatsAppMessageUrl(whatsappUrl: string, message: string) {
  if (!whatsappUrl.trim()) {
    return "";
  }

  try {
    const url = new URL(whatsappUrl);
    url.searchParams.set("text", message);
    return url.toString();
  } catch {
    return "";
  }
}
