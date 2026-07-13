import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createVerificationToken,
  isValidVerificationSigningSecret,
  verificationSigningSecretMinimumBytes,
  verificationTokenMaxAgeMs,
  verifyVerificationToken,
} from "../src/lib/auth/verification-token-core.ts";

const now = 1_800_000_000_000;
const legacySecret = "legacy-test-material-that-is-never-a-real-key";
const dedicatedSecret = "dedicated-test-material-with-at-least-32-bytes";
const wrongDedicatedSecret = "wrong-test-secret-with-at-least-32-bytes";
const shortDedicatedSecret = "short-test-value";

function alterToken(token) {
  return `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
}

assert.equal(verificationSigningSecretMinimumBytes, 32);
assert.equal(isValidVerificationSigningSecret(dedicatedSecret), true);
assert.equal(isValidVerificationSigningSecret(shortDedicatedSecret), false);

const dedicatedToken = createVerificationToken({ now, dedicatedSecret, legacySecret });
assert.match(dedicatedToken, /^v2\.verification-success\.verified\.[0-9]+\.[a-f0-9]{64}$/);
assert.equal(verifyVerificationToken({ token: dedicatedToken, now, dedicatedSecret, legacySecret }), true);
assert.equal(
  verifyVerificationToken({ token: dedicatedToken, now, dedicatedSecret: wrongDedicatedSecret, legacySecret }),
  false,
);

const legacyToken = createVerificationToken({ now, legacySecret });
assert.match(legacyToken, /^verified\.[0-9]+\.[a-f0-9]{64}$/);
assert.equal(verifyVerificationToken({ token: legacyToken, now, dedicatedSecret, legacySecret }), true);
assert.equal(
  verifyVerificationToken({
    token: legacyToken,
    now: now + verificationTokenMaxAgeMs + 1,
    dedicatedSecret,
    legacySecret,
  }),
  false,
);
assert.equal(verifyVerificationToken({ token: alterToken(legacyToken), now, dedicatedSecret, legacySecret }), false);
assert.equal(
  verifyVerificationToken({
    token: legacyToken.replace("verified", "password-reset"),
    now,
    dedicatedSecret,
    legacySecret,
  }),
  false,
);
assert.equal(
  verifyVerificationToken({
    token: dedicatedToken.replace("verification-success", "password-reset"),
    now,
    dedicatedSecret,
    legacySecret,
  }),
  false,
);
assert.equal(verifyVerificationToken({ token: "malformed", now, dedicatedSecret, legacySecret }), false);
assert.equal(
  verifyVerificationToken({ token: dedicatedToken.replace("v2", "v3"), now, dedicatedSecret, legacySecret }),
  false,
);
assert.equal(
  verifyVerificationToken({ token: dedicatedToken, now, dedicatedSecret: shortDedicatedSecret, legacySecret }),
  false,
);

const shortSecretFallbackToken = createVerificationToken({ now, dedicatedSecret: shortDedicatedSecret, legacySecret });
assert.match(shortSecretFallbackToken, /^verified\.[0-9]+\.[a-f0-9]{64}$/);
assert.equal(verifyVerificationToken({ token: shortSecretFallbackToken, now, dedicatedSecret, legacySecret }), true);

assert.equal(dedicatedToken.includes(dedicatedSecret), false);
assert.equal(legacyToken.includes(legacySecret), false);
assert.equal(shortSecretFallbackToken.includes(shortDedicatedSecret), false);

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [signingHelper, serverWrapper, boundaryGuard] = await Promise.all([
  read("src/lib/auth/verification-signing-secret.ts"),
  read("src/lib/auth/verification-token.ts"),
  read("scripts/security-client-boundary.mjs"),
]);

assert.match(signingHelper, /^import "server-only";/);
assert.match(signingHelper, /process\.env\.VERIFICATION_SIGNING_SECRET/);
assert.match(signingHelper, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
assert.match(signingHelper, /isValidVerificationSigningSecret/);
assert.doesNotMatch(signingHelper, /NEXT_PUBLIC_VERIFICATION/);
assert.doesNotMatch(signingHelper, /console\.(?:warn|error|log)\([^)]*secret/iu);
assert.match(signingHelper, /throw new Error\("Server configuration is unavailable\."\)/);
assert.match(serverWrapper, /^import "server-only";/);
assert.match(boundaryGuard, /src\/lib\/auth\/verification-token-core\.ts/);

const safeOutput = JSON.stringify({
  tokenVersions: ["v1-compatible", "v2"],
  tokenMaxAgeMinutes: verificationTokenMaxAgeMs / 60_000,
  dedicatedSecretMinimumBytes: verificationSigningSecretMinimumBytes,
  productionDependencies: 0,
});
for (const testSecret of [legacySecret, dedicatedSecret, wrongDedicatedSecret, shortDedicatedSecret]) {
  assert.equal(safeOutput.includes(testSecret), false);
}

console.log("Phase S3A token-signing security checks passed.", {
  tokenVersions: ["v1-compatible", "v2"],
  tokenMaxAgeMinutes: verificationTokenMaxAgeMs / 60_000,
  dedicatedSecretMinimumBytes: verificationSigningSecretMinimumBytes,
  productionDependencies: 0,
});
