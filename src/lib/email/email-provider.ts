import "server-only";

export type EmailProviderName = "resend" | "brevo" | "none";

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

export type SendEmailResult = {
  ok: boolean;
  status: "sent" | "failed" | "skipped";
  provider: EmailProviderName;
  providerMessageId: string | null;
  errorMessage: string | null;
  technicalMessage?: string | null;
};

const resendEndpoint = "https://api.resend.com/emails";
const brevoEndpoint = "https://api.brevo.com/v3/smtp/email";

function normalizeProvider(value: string | undefined): EmailProviderName {
  const provider = value?.trim().toLowerCase();

  if (provider === "brevo" || provider === "resend") {
    return provider;
  }

  if (process.env.BREVO_API_KEY && process.env.BREVO_FROM_EMAIL) {
    return "brevo";
  }

  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL) {
    return "resend";
  }

  return "none";
}

export function getEmailProviderStatus() {
  const provider = normalizeProvider(process.env.EMAIL_PROVIDER);
  const resendConfigured = Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
  const brevoConfigured = Boolean(process.env.BREVO_API_KEY && process.env.BREVO_FROM_EMAIL);

  return {
    provider,
    resendConfigured,
    brevoConfigured,
    configured:
      provider === "resend" ? resendConfigured : provider === "brevo" ? brevoConfigured : false,
  };
}

function getResendFromEmail() {
  return process.env.RESEND_FROM_EMAIL || "Car Zone Accesorios <onboarding@resend.dev>";
}

function getBrevoSender() {
  return {
    email: process.env.BREVO_FROM_EMAIL ?? "",
    name: process.env.BREVO_SENDER_NAME || "Car Zone Accesorios",
  };
}

function safeErrorMessage(message: string) {
  if (message.toLowerCase().includes("api key")) {
    return "Proveedor de correo no configurado correctamente.";
  }

  return message;
}

async function sendWithResend(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey || !process.env.RESEND_FROM_EMAIL) {
    return {
      ok: false,
      status: "skipped",
      provider: "resend",
      providerMessageId: null,
      errorMessage: "Resend no esta configurado. Define RESEND_API_KEY y RESEND_FROM_EMAIL.",
      technicalMessage: "Missing RESEND_API_KEY or RESEND_FROM_EMAIL.",
    };
  }

  const response = await fetch(resendEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: getResendFromEmail(),
      to: input.to,
      subject: input.subject,
      html: input.html,
    }),
  });

  const payload = (await response.json().catch(() => null)) as { id?: string; message?: string; error?: string } | null;

  if (!response.ok) {
    const message = payload?.message || payload?.error || `Resend responded with status ${response.status}.`;
    return {
      ok: false,
      status: "failed",
      provider: "resend",
      providerMessageId: null,
      errorMessage: safeErrorMessage(message),
      technicalMessage: message,
    };
  }

  return {
    ok: true,
    status: "sent",
    provider: "resend",
    providerMessageId: payload?.id ?? null,
    errorMessage: null,
  };
}

async function sendWithBrevo(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.BREVO_API_KEY;
  const sender = getBrevoSender();

  if (!apiKey || !sender.email) {
    return {
      ok: false,
      status: "skipped",
      provider: "brevo",
      providerMessageId: null,
      errorMessage: "Brevo no esta configurado. Define BREVO_API_KEY y BREVO_FROM_EMAIL.",
      technicalMessage: "Missing BREVO_API_KEY or BREVO_FROM_EMAIL.",
    };
  }

  const response = await fetch(brevoEndpoint, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender,
      to: [{ email: input.to }],
      subject: input.subject,
      htmlContent: input.html,
      tags: ["car-zone", "transactional"],
      params: input.metadata ?? {},
    }),
  });

  const payload = (await response.json().catch(() => null)) as { messageId?: string; message?: string; code?: string } | null;

  if (!response.ok) {
    const message = payload?.message || payload?.code || `Brevo responded with status ${response.status}.`;
    return {
      ok: false,
      status: "failed",
      provider: "brevo",
      providerMessageId: null,
      errorMessage: safeErrorMessage(message),
      technicalMessage: message,
    };
  }

  return {
    ok: true,
    status: "sent",
    provider: "brevo",
    providerMessageId: payload?.messageId ?? null,
    errorMessage: null,
  };
}

export async function sendTransactionalEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const status = getEmailProviderStatus();

  try {
    if (status.provider === "resend") {
      return sendWithResend(input);
    }

    if (status.provider === "brevo") {
      return sendWithBrevo(input);
    }

    return {
      ok: false,
      status: "skipped",
      provider: "none",
      providerMessageId: null,
      errorMessage: "No hay proveedor de correo configurado. Define EMAIL_PROVIDER con Resend o Brevo.",
      technicalMessage: "EMAIL_PROVIDER, API key or from email are missing.",
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      provider: status.provider,
      providerMessageId: null,
      errorMessage: "No se pudo enviar el correo transaccional.",
      technicalMessage: error instanceof Error ? error.message : "Unknown email provider error.",
    };
  }
}
