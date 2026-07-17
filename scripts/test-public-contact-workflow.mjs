import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const contactActions = await readFile(new URL("../src/app/contacto/actions.ts", import.meta.url), "utf8");
const registeredWholesaleActions = await readFile(new URL("../src/app/actions/wholesale.ts", import.meta.url), "utf8");
const wholesaleRequestForm = await readFile(new URL("../src/components/store/wholesale-request-form.tsx", import.meta.url), "utf8");
const wholesaleAccountCard = await readFile(new URL("../src/components/store/wholesale-account-request-card.tsx", import.meta.url), "utf8");
const contactPage = await readFile(new URL("../src/app/contacto/page.tsx", import.meta.url), "utf8");
const accountPage = await readFile(new URL("../src/app/cuenta/page.tsx", import.meta.url), "utf8");
const wholesaleRedirectPage = await readFile(new URL("../src/app/solicitar-mayoreo/page.tsx", import.meta.url), "utf8");
const notifications = await readFile(new URL("../src/lib/public-form-support.ts", import.meta.url), "utf8");
const migration = await readFile(
  new URL("../supabase/migrations/202605310003_public_contact_workflow_hardening.sql", import.meta.url),
  "utf8",
);
const settingsTypes = await readFile(new URL("../src/types/settings.ts", import.meta.url), "utf8");

assert.match(contactActions, /rpc\("submit_public_general_contact"/);
assert.doesNotMatch(contactActions, /submitWholesaleRequestAction/);
assert.doesNotMatch(contactActions, /rpc\("submit_public_wholesale_request"/);
assert.match(contactActions, /Mensaje enviado correctamente\. Nuestro equipo te responderá pronto\./);

assert.match(wholesaleRequestForm, /WholesaleProgramConditionsCard/);
assert.match(wholesaleRequestForm, /¿Ya tienes una cuenta\? Inicia sesión para solicitar acceso mayorista\. Si aún no tienes una, créala en menos de un minuto\./);
assert.match(wholesaleRequestForm, /href="\/login\?next=\/contacto%23mayoreo"/);
assert.match(wholesaleRequestForm, />\s*Iniciar sesión\s*</);
assert.match(wholesaleRequestForm, /href="\/registro"/);
assert.match(wholesaleRequestForm, />\s*Crear cuenta\s*</);
assert.equal(
  new URL("https://carzoneaccesorios.com/login?next=/contacto%23mayoreo").searchParams.get("next"),
  "/contacto#mayoreo",
);
assert.match(wholesaleRequestForm, /initialAccessState\.kind !== "guest"/);
assert.match(wholesaleRequestForm, /WholesaleAccountRequestCard initialState=\{initialAccessState\}/);
assert.doesNotMatch(wholesaleRequestForm, /submitWholesaleRequestAction/);
assert.doesNotMatch(wholesaleRequestForm, /<form|<input|<textarea|businessName|contactName|taxId|comment/);

assert.match(wholesaleAccountCard, /submitRegisteredWholesaleRequestAction/);
assert.match(wholesaleAccountCard, /state\.kind === "regular"/);
assert.match(wholesaleAccountCard, /Solicitud mayorista en revisión/);
assert.match(wholesaleAccountCard, /Cuenta mayorista activa/);
assert.match(wholesaleAccountCard, /Solicitud mayorista revisada/);
assert.match(wholesaleAccountCard, /Acceso mayorista suspendido/);
assert.match(registeredWholesaleActions, /if \(!user\)/);
assert.match(registeredWholesaleActions, /userProfile\.active === false/);
assert.match(registeredWholesaleActions, /route: "\/contacto\/mayoreo\/cuenta"/);
assert.match(registeredWholesaleActions, /\.eq\("user_id", userId\)/);
assert.match(registeredWholesaleActions, /user_id: null/);
assert.match(registeredWholesaleActions, /ensureRegisteredWholesaleFollowup/);
assert.match(registeredWholesaleActions, /rejectedReview: true/);
assert.match(registeredWholesaleActions, /writeRegisteredWholesaleAudit/);
assert.match(contactPage, /getWholesaleAccessStateAction\(\)/);
assert.match(accountPage, /WholesaleAccountRequestCard initialState=\{wholesaleState\} context="account"/);
assert.match(wholesaleRedirectPage, /redirect\("\/contacto#mayoreo"\)/);

assert.match(migration, /notify_general_contact boolean not null default true/);
assert.match(migration, /create or replace function public\.submit_public_general_contact/);
assert.match(migration, /create or replace function public\.submit_public_wholesale_request/);
assert.match(migration, /now\(\) \+ interval '24 hours'/);
assert.match(migration, /assigned_user_id/);
assert.match(migration, /public_form\.contact_general\.submitted/);
assert.match(migration, /public_form\.wholesale\.duplicate_pending/);
assert.match(migration, /public_form\.wholesale\.overwrite_blocked/);
assert.match(migration, /current_wholesale_status in \('approved', 'suspended'\)/);
assert.match(migration, /next_outcome := 'rejected_review'/);

assert.match(notifications, /enqueueEmail/);
assert.match(notifications, /queuePreferenceEmail/);
assert.match(notifications, /notification_logs/);
assert.match(notifications, /writeErrorLog/);
assert.match(notifications, /notify_general_contact/);
assert.match(notifications, /notify_wholesale_requests/);
assert.match(settingsTypes, /notify_general_contact: boolean/);

console.log("Public contact workflow structural checks passed.");
