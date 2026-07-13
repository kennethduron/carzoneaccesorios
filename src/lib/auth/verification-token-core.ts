import { createHmac, timingSafeEqual } from "crypto";

export type VerificationStatus = "verified" | "already";

export const verificationTokenMaxAgeMs = 10 * 60 * 1000;
export const verificationSigningSecretMinimumBytes = 32;
const maxClockSkewMs = 60 * 1000;
const signaturePattern = /^[a-f0-9]{64}$/;
const verificationPurpose = "verification-success";

export function isValidVerificationSigningSecret(secret: string | null | undefined): secret is string {
  return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= verificationSigningSecretMinimumBytes;
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function validTimestamp(timestamp: string, now: number) {
  const parsed = Number(timestamp);
  return Number.isFinite(parsed) && parsed <= now + maxClockSkewMs && now - parsed <= verificationTokenMaxAgeMs;
}

function validStatus(status: string): status is VerificationStatus {
  return status === "verified" || status === "already";
}

function signaturesMatch(actual: string, expected: string) {
  if (!signaturePattern.test(actual)) return false;
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createVerificationToken(input: {
  status?: VerificationStatus;
  now?: number;
  dedicatedSecret?: string | null;
  legacySecret: string;
}) {
  const status = input.status ?? "verified";
  const timestamp = (input.now ?? Date.now()).toString();
  if (isValidVerificationSigningSecret(input.dedicatedSecret)) {
    const payload = `v2.${verificationPurpose}.${status}.${timestamp}`;
    return `${payload}.${signature(payload, input.dedicatedSecret)}`;
  }
  const payload = `${status}.${timestamp}`;
  return `${payload}.${signature(payload, input.legacySecret)}`;
}

export function verifyVerificationToken(input: {
  token: string | null | undefined;
  now?: number;
  dedicatedSecret?: string | null;
  legacySecret: string;
}) {
  if (!input.token) return false;
  const now = input.now ?? Date.now();
  const parts = input.token.split(".");

  if (parts.length === 3) {
    const [status, timestamp, actualSignature] = parts;
    if (!validStatus(status) || !validTimestamp(timestamp, now)) return false;
    const payload = `${status}.${timestamp}`;
    return signaturesMatch(actualSignature, signature(payload, input.legacySecret));
  }

  if (parts.length === 5) {
    const [version, purpose, status, timestamp, actualSignature] = parts;
    if (
      version !== "v2" ||
      purpose !== verificationPurpose ||
      !isValidVerificationSigningSecret(input.dedicatedSecret) ||
      !validStatus(status) ||
      !validTimestamp(timestamp, now)
    ) return false;
    const payload = `${version}.${purpose}.${status}.${timestamp}`;
    return signaturesMatch(actualSignature, signature(payload, input.dedicatedSecret));
  }

  return false;
}
