import "server-only";

import { isValidVerificationSigningSecret } from "@/lib/auth/verification-token-core";

let warnedAboutInvalidDedicatedSecret = false;

function getDedicatedSecret() {
  const secret = process.env.VERIFICATION_SIGNING_SECRET;
  if (!secret) return null;

  if (!isValidVerificationSigningSecret(secret)) {
    if (!warnedAboutInvalidDedicatedSecret) {
      console.warn("Dedicated verification signing configuration is invalid; legacy compatibility remains active.");
      warnedAboutInvalidDedicatedSecret = true;
    }
    return null;
  }

  return secret;
}

export function getVerificationSigningSecrets() {
  const legacySecret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!legacySecret) throw new Error("Server configuration is unavailable.");
  return { dedicatedSecret: getDedicatedSecret(), legacySecret };
}
