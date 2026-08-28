export const productImageSharpImportFailureEvent = "PRODUCT_IMAGE_SHARP_IMPORT_FAILURE";

export type ProductImageSharpImportDiagnostic = {
  errorName: string;
  errorCode: string | null;
  errorMessageSanitized: string;
  stackOrigin: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
};

function sanitizeSecrets(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted-token>")
    .replace(/\b(?:sk|pk|rk|supabase|resend|brevo)_[A-Za-z0-9_-]{8,}\b/gi, "<redacted-key>")
    .replace(
      /\b(api[-_ ]?key|authorization|token|secret|password)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=<redacted>",
    );
}

function sanitizeRuntimePaths(value: string) {
  return value
    .replace(/\/var\/task(?=\/|\b)/gi, "<runtime>")
    .replace(/\/vercel\/path\d*(?=\/|\b)/gi, "<build>")
    .replace(/[A-Za-z]:\\(?:[^\s"'()]+\\)*[^\s"'()]*/g, "<runtime-path>")
    .replace(/(?<![A-Za-z0-9_>])\/(?:[^/\s"'()]+\/)*[^/\s"'()]*/g, "<runtime-path>");
}

function sanitizeDiagnosticText(value: string, maxLength: number, flattenLines: boolean) {
  const normalized = flattenLines ? value.replace(/[\r\n]+/g, " ") : value.replace(/\r/g, "");
  return sanitizeRuntimePaths(sanitizeSecrets(normalized)).slice(0, maxLength);
}

function readErrorCode(error: unknown) {
  try {
    if (!error || typeof error !== "object") return null;
    const code = (error as { code?: unknown }).code;
    if (typeof code !== "string" && typeof code !== "number") return null;
    return sanitizeDiagnosticText(String(code), 120, true);
  } catch {
    return null;
  }
}

export function createProductImageSharpImportDiagnostic(error: unknown): ProductImageSharpImportDiagnostic {
  const errorName = error instanceof Error
    ? sanitizeDiagnosticText(error.name || "Error", 120, true)
    : "UnknownError";
  const errorMessageSanitized = error instanceof Error
    ? sanitizeDiagnosticText(error.message, 500, true)
    : "Unknown Sharp import error";
  const stackOrigin = error instanceof Error && error.stack
    ? error.stack
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .slice(0, 4)
        .map((line) => sanitizeDiagnosticText(line, 500, false))
        .join("\n")
        .slice(0, 1000)
    : "";

  return {
    errorName,
    errorCode: readErrorCode(error),
    errorMessageSanitized,
    stackOrigin,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}
