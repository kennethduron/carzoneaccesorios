import assert from "node:assert/strict";
import {
  buildWhatsAppMessageUrl,
  normalizeWhatsAppUrl,
  sanitizeContactSettings,
  validateHondurasPhone,
} from "../src/utils/contact-settings.ts";

assert.equal(normalizeWhatsAppUrl(""), "");
assert.equal(normalizeWhatsAppUrl("9999-8888"), "https://wa.me/50499998888");
assert.equal(normalizeWhatsAppUrl("+504 (9999) 8888"), "https://wa.me/50499998888");
assert.equal(normalizeWhatsAppUrl("50499998888"), "https://wa.me/50499998888");
assert.equal(normalizeWhatsAppUrl("https://wa.me/50499998888"), "https://wa.me/50499998888");
assert.equal(
  normalizeWhatsAppUrl("https://api.whatsapp.com/send?phone=50499998888"),
  "https://wa.me/50499998888",
);
assert.equal(validateHondurasPhone("+504 9999-8888"), "+504 9999-8888");
assert.throws(() => normalizeWhatsAppUrl("https://example.com/50499998888"), /wa\.me/);
assert.throws(() => normalizeWhatsAppUrl("123"), /8 dígitos/);

const empty = sanitizeContactSettings({
  facebook_url: "",
  instagram_url: "",
  tiktok_url: "",
  whatsapp_url: "",
  customer_service_whatsapp: "",
  customer_service_phone: "",
  customer_service_email: "",
  business_address: "",
  customer_service_hours: "",
});
assert.deepEqual(Object.values(empty), Array(Object.keys(empty).length).fill(""));

const populated = sanitizeContactSettings({
  facebook_url: "https://facebook.com/carzone",
  instagram_url: "https://instagram.com/carzone",
  tiktok_url: "https://tiktok.com/@carzone",
  whatsapp_url: "9999-8888",
  customer_service_whatsapp: "https://api.whatsapp.com/send?phone=50488887777",
  customer_service_phone: "+504 9999-8888",
  customer_service_email: "ventas@example.com",
  business_address: "San Pedro Sula",
  customer_service_hours: "Lunes a sábado",
});
assert.equal(populated.whatsapp_url, "https://wa.me/50499998888");
assert.equal(populated.customer_service_whatsapp, "https://wa.me/50488887777");
assert.match(
  buildWhatsAppMessageUrl(populated.whatsapp_url, "Hola producto"),
  /^https:\/\/wa\.me\/50499998888\?text=Hola(\+|%20)producto$/,
);

console.log("Contact settings normalization tests passed.");
