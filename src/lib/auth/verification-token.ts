import "server-only";

import { createVerificationToken, verifyVerificationToken, type VerificationStatus } from "@/lib/auth/verification-token-core";
import { getVerificationSigningSecrets } from "@/lib/auth/verification-signing-secret";

export function createVerificationSuccessToken(status: VerificationStatus = "verified") {
  return createVerificationToken({ status, ...getVerificationSigningSecrets() });
}

export function verifyVerificationSuccessToken(token: string | null | undefined) {
  return verifyVerificationToken({ token, ...getVerificationSigningSecrets() });
}
