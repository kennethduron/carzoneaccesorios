import "server-only";

import { createHash } from "crypto";

export type OperationalSeverity = "info" | "warning" | "error" | "critical";
export type OperationalCategory =
  | "auth"
  | "crm"
  | "checkout"
  | "payments"
  | "invoices"
  | "inventory"
  | "wholesale"
  | "email"
  | "cron"
  | "system";

export type OperationalErrorContext = {
  module: string;
  action: string;
  route?: string | null;
  category: OperationalCategory;
  severity?: OperationalSeverity;
  retryAfterSeconds?: number;
};

export type MappedOperationalError = {
  customerMessage: string;
  adminReason: string;
  recommendation: string;
  severity: OperationalSeverity;
  category: OperationalCategory;
  module: string;
  action: string;
  route: string | null;
  code: string | null;
  status: number | null;
  originalMessage: string;
};

const sensitiveKeyPattern = /password|token|cookie|secret|api[-_]?key|authorization|session|jwt|refresh|access/i;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function maskEmail(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return null;
  }

  const [name, domain] = normalized.split("@");
  if (!name || !domain) {
    return null;
  }

  const visibleName = name.length <= 2 ? `${name[0] ?? "*"}*` : `${name.slice(0, 2)}***`;
  const [domainName, ...domainRest] = domain.split(".");
  const visibleDomain = domainName.length <= 2 ? `${domainName[0] ?? "*"}*` : `${domainName.slice(0, 2)}***`;
  return `${visibleName}@${visibleDomain}.${domainRest.join(".") || "com"}`;
}

export function hashEmail(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return null;
  }

  const salt = process.env.ERROR_LOG_HASH_SALT ?? process.env.RATE_LIMIT_SALT ?? "car-zone-error-log";
  return createHash("sha256").update(`${salt}:${normalized}`).digest("hex");
}

function sanitizeString(value: string) {
  return value.replace(emailPattern, (email) => maskEmail(email) ?? "[correo]").slice(0, 800);
}

export function sanitizeLogText(value: string | null | undefined, maxLength = 1200) {
  return (value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-token]")
    .replace(/\b(?:sk|pk|rk|supabase|resend|brevo)_[A-Za-z0-9_-]{16,}\b/gi, "[redacted-key]")
    .replace(emailPattern, (email) => maskEmail(email) ?? "[correo]")
    .slice(0, maxLength);
}

export function sanitizeMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  function clean(value: unknown, key = "", depth = 0): unknown {
    if (sensitiveKeyPattern.test(key)) {
      return "[redacted]";
    }

    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === "string") {
      return sanitizeString(value);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (Array.isArray(value)) {
      return depth >= 2 ? "[array]" : value.slice(0, 20).map((item) => clean(item, key, depth + 1));
    }

    if (typeof value === "object") {
      if (depth >= 3) {
        return "[object]";
      }

      return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [entryKey, entryValue]) => {
        acc[entryKey] = clean(entryValue, entryKey, depth + 1);
        return acc;
      }, {});
    }

    return String(value);
  }

  return clean(metadata) as Record<string, unknown>;
}

function getRawErrorValue(error: unknown, key: "message" | "code" | "status") {
  if (!error || typeof error !== "object") {
    return null;
  }

  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  const message = getRawErrorValue(error, "message");
  if (message) {
    return String(message);
  }

  return typeof error === "string" ? error : "Unknown error";
}

export function getErrorCode(error: unknown) {
  const code = getRawErrorValue(error, "code");
  return code ? String(code) : null;
}

export function getErrorStatus(error: unknown) {
  const status = getRawErrorValue(error, "status");
  const parsed = typeof status === "number" ? status : Number(status);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function rateLimitCustomerMessage(retryAfterSeconds?: number) {
  const base = "Por seguridad, hemos pausado temporalmente los intentos. Intenta nuevamente en unos minutos.";
  if (!retryAfterSeconds || retryAfterSeconds <= 0) {
    return base;
  }

  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `${base} Podrás intentar nuevamente en aproximadamente ${minutes} ${minutes === 1 ? "minuto" : "minutos"}.`;
}

export function mapOperationalError(error: unknown, context: OperationalErrorContext): MappedOperationalError {
  const originalMessage = getErrorMessage(error);
  const message = originalMessage.toLowerCase();
  const code = getErrorCode(error);
  const status = getErrorStatus(error);
  const base = {
    severity: context.severity ?? "error",
    category: context.category,
    module: context.module,
    action: context.action,
    route: context.route ?? null,
    code,
    status,
    originalMessage,
  };

  if (code === "over_email_send_rate_limit" || message.includes("email rate limit")) {
    return {
      ...base,
      severity: "warning",
      customerMessage:
        "Supabase limitó temporalmente el envío de correos de verificación. Intenta nuevamente en unos minutos.",
      adminReason: "Supabase Auth bloqueó el registro por límite de envío de correos.",
      recommendation: "Configurar SMTP personalizado en Supabase Auth y ajustar el límite rate_limit_email_sent para producción.",
    };
  }

  if (message.includes("error sending confirmation email") || message.includes("sending confirmation email")) {
    return {
      ...base,
      severity: "critical",
      customerMessage:
        "No pudimos enviar el correo de verificación. Intenta nuevamente más tarde o contacta al equipo de soporte.",
      adminReason: "Supabase Auth no pudo enviar el correo de confirmación desde el proveedor SMTP configurado.",
      recommendation:
        "Revisar SMTP de Supabase Auth: host, puerto, usuario, API key, remitente y dominio verificado en Resend.",
    };
  }

  if (status === 429 || message.includes("rate limit") || message.includes("too many")) {
    return {
      ...base,
      severity: "warning",
      customerMessage: rateLimitCustomerMessage(context.retryAfterSeconds),
      adminReason: context.action.includes("register")
        ? "Supabase Auth devolvió rate limit en registro."
        : "Supabase Auth limitó temporalmente la acción solicitada.",
      recommendation: "Pedir al cliente esperar unos minutos antes de intentar nuevamente.",
    };
  }

  if (message.includes("already registered") || message.includes("user already") || message.includes("already exists")) {
    return {
      ...base,
      severity: "info",
      customerMessage: "Este correo ya tiene una cuenta registrada. Intenta iniciar sesión o recupera tu contraseña.",
      adminReason: "Registro bloqueado porque el correo ya existe.",
      recommendation: "Guiar al cliente a iniciar sesión o usar recuperación de contraseña.",
    };
  }

  if (message.includes("username")) {
    return {
      ...base,
      severity: "info",
      customerMessage: "Este nombre de usuario ya está en uso. Prueba con otro.",
      adminReason: "Registro bloqueado porque el nombre de usuario ya existe.",
      recommendation: "Pedir al cliente elegir un nombre de usuario diferente.",
    };
  }

  if (message.includes("email not confirmed") || message.includes("not confirmed")) {
    return {
      ...base,
      severity: "warning",
      customerMessage: "Debes confirmar tu correo antes de iniciar sesión.",
      adminReason: "Inicio de sesión bloqueado porque el correo no está verificado.",
      recommendation: "Reenviar enlace de verificación si el cliente no lo encuentra.",
    };
  }

  if (message.includes("invalid login credentials")) {
    return {
      ...base,
      severity: "info",
      customerMessage: "Correo, usuario o contraseña incorrectos.",
      adminReason: "Supabase Auth rechazó las credenciales de inicio de sesión.",
      recommendation: "Pedir al cliente revisar sus datos o recuperar contraseña.",
    };
  }

  if (message.includes("expired") || message.includes("invalid") || message.includes("otp") || message.includes("token")) {
    return {
      ...base,
      severity: "warning",
      customerMessage: "El enlace ya fue usado o expiró. Puedes solicitar uno nuevo.",
      adminReason: "Token de verificación o recuperación expirado, inválido o ya usado.",
      recommendation: "Reenviar enlace de verificación o recuperación.",
    };
  }

  if (message.includes("stock") || message.includes("inventario")) {
    return {
      ...base,
      severity: "warning",
      customerMessage: "No pudimos completar la compra porque el inventario cambió. Revisa tu carrito e inténtalo nuevamente.",
      adminReason: "Checkout bloqueado por stock insuficiente.",
      recommendation: "Verificar stock y reservas de inventario.",
    };
  }

  if (message.includes("payment") || message.includes("pago")) {
    return {
      ...base,
      severity: "warning",
      customerMessage: "No pudimos confirmar el pago todavía. Si ya pagaste, contacta al equipo de soporte.",
      adminReason: "La operación depende de un pago que aún no está confirmado.",
      recommendation: "Revisar pago manualmente.",
    };
  }

  if (message.includes("invoice") || message.includes("factura") || message.includes("cai")) {
    return {
      ...base,
      severity: "error",
      customerMessage: "No pudimos generar el documento en este momento. El equipo puede revisarlo.",
      adminReason: "Factura no generada por validación fiscal, pago pendiente o configuración incompleta.",
      recommendation: "Revisar pago, CAI y configuración fiscal.",
    };
  }

  if (message.includes("fetch failed") || message.includes("network") || message.includes("connection") || message.includes("econn")) {
    return {
      ...base,
      severity: "warning",
      customerMessage: "No pudimos completar la acción por un problema de conexión. Inténtalo nuevamente.",
      adminReason: "La acción falló por conexión o proveedor externo no disponible.",
      recommendation: "Intentar nuevamente y escalar a soporte técnico si se repite.",
    };
  }

  return {
    ...base,
    customerMessage: "No pudimos completar la acción. Si el problema continúa, contacta al equipo de soporte.",
    adminReason: "Error inesperado durante la operación.",
    recommendation: "Escalar a soporte técnico si el error se repite.",
  };
}
