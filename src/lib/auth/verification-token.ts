import { createHmac, timingSafeEqual } from "crypto";

type VerificationStatus = "verified" | "already";

const maxAgeMs = 10 * 60 * 1000;

function getSigningSecret() {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY for verification token signing");
  }

  return secret;
}

function sign(payload: string) {
  return createHmac("sha256", getSigningSecret()).update(payload).digest("hex");
}

export function createVerificationSuccessToken(status: VerificationStatus = "verified") {
  const timestamp = Date.now().toString();
  const payload = `${status}.${timestamp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyVerificationSuccessToken(token: string | null | undefined) {
  if (!token) {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }

  const [status, timestamp, signature] = parts;
  if (status !== "verified" && status !== "already") {
    return false;
  }

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Date.now() - timestampNumber > maxAgeMs || timestampNumber > Date.now() + 60_000) {
    return false;
  }

  const expected = sign(`${status}.${timestamp}`);
  const signatureBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(signatureBuffer, expectedBuffer);
}
