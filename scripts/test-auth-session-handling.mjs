import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  authTelemetryCookieName,
  isRefreshTokenNotFound,
  localAuthCookieNames,
  safeAuthErrorCode,
  safeNextPath,
} from "../src/lib/auth/session-errors.ts";

assert.equal(isRefreshTokenNotFound({ code: "refresh_token_not_found" }), true);
assert.equal(isRefreshTokenNotFound({ code: "REFRESH_TOKEN_NOT_FOUND" }), true);
assert.equal(isRefreshTokenNotFound({ code: "refresh_token_already_used" }), false);
assert.equal(isRefreshTokenNotFound({ message: "refresh_token_not_found" }), false, "only the exact SDK code is handled as expired");
assert.equal(safeAuthErrorCode({ code: "network_error" }), "network_error");
assert.equal(safeAuthErrorCode({ code: "unsafe code: token=secret" }), "auth_error_unclassified");

assert.deepEqual(
  localAuthCookieNames([
    { name: "sb-project-auth-token" },
    { name: "sb-project-auth-token.0" },
    { name: "sb-project-auth-token.1" },
    { name: "sb-project-auth-token-code-verifier" },
    { name: "other-cookie" },
  ]),
  ["sb-project-auth-token", "sb-project-auth-token.0", "sb-project-auth-token.1"],
  "only the invalid local Supabase session cookies are cleared",
);
assert.equal(safeNextPath("/admin/clientes", "?view=duplicates"), "/admin/clientes?view=duplicates");
assert.equal(safeNextPath("//attacker.example", ""), "/");
assert.equal(authTelemetryCookieName.includes("token"), false);

const [proxy, authCard] = await Promise.all([
  readFile(new URL("../src/proxy.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/components/forms/auth-card.tsx", import.meta.url), "utf8"),
]);

assert.match(proxy, /isRefreshTokenNotFound\(authError\)/);
assert.match(proxy, /auth\.session_expired_handled/);
assert.match(proxy, /auth\.login_required/);
assert.match(proxy, /auth\.refresh_failed_unexpected/);
assert.match(proxy, /auth\.permission_denied/);
assert.match(proxy, /maxAge: 300/);
assert.doesNotMatch(proxy, /auth\.signOut\(/, "the proxy never revokes a global session");
assert.doesNotMatch(proxy, /error\.message/, "raw auth messages are not logged or placed in URLs");
assert.match(authCard, /Su sesión expiró\. Inicie sesión nuevamente\./);

console.log("Auth session expiration handling checks passed.");
