import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manager = readFileSync(new URL("../src/components/admin/crm-manager.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("../src/app/admin/crm/actions.ts", import.meta.url), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing section: ${start}`);
  return source.slice(from, to);
}

const mutations = section(manager, "async function approveWholesaleCustomer", "function applyCanonicalCustomerProfile");
const refreshFlow = section(manager, "function applyCanonicalCustomerProfile", "function closeCustomerProfile");
const drawer = section(manager, "function CustomerProfileDrawer", "function CustomerProfileSummary");
const credit = section(manager, "function CustomerProfileCredit", "function CustomerProfileActions");

assert.doesNotMatch(mutations, /await openCustomerProfile\(customer\.id\)/, "Wholesale mutations must not blank and reopen the profile");
assert.match(mutations, /reconcileCustomerProfileMutation/, "Commercial mutations must reconcile the open profile");
const customerSuspend = section(manager, "async function suspendCustomer", "async function reactivateCustomer");
const customerReactivate = section(manager, "async function reactivateCustomer", "async function deleteTestCustomer");
assert.doesNotMatch(customerSuspend, /closeActiveCustomerWindows\(customer\.id\)/, "Suspension must not close the open profile");
assert.doesNotMatch(customerReactivate, /closeActiveCustomerWindows\(customer\.id\)/, "Reactivation must not close the open profile");

assert.match(refreshFlow, /profileRequestRevisionRef/, "Profile requests need a revision guard");
assert.match(refreshFlow, /profileCustomerIdRef\.current !== customerId/, "Late responses must be scoped to the selected customer");
assert.match(refreshFlow, /setProfileRefreshing\(true\)/, "Background refresh must expose a processing state");
assert.match(refreshFlow, /const lockKey = customerId/, "Only one commercial mutation may run per customer");
assert.match(refreshFlow, /result\.profile \? applyCanonicalCustomerProfile/, "The canonical mutation response must update the open profile");
assert.match(refreshFlow, /if \(profileCustomerIdRef\.current === customerId && customerProfile\?\.customer\.id === customerId\)/, "Reopening the same customer must use a background refresh");

const sameCustomerBranch = refreshFlow.slice(
  refreshFlow.indexOf("if (profileCustomerIdRef.current === customerId && customerProfile?.customer.id === customerId)"),
  refreshFlow.indexOf("const requestRevision = ++profileRequestRevisionRef.current", refreshFlow.indexOf("async function openCustomerProfile")),
);
assert.match(sameCustomerBranch, /return refreshCustomerProfile\(customerId\)/);
assert.doesNotMatch(sameCustomerBranch, /setCustomerProfile\(null\)/, "The current valid profile must remain visible while refreshing");

assert.match(drawer, /aria-busy=\{pending \|\| refreshing\}/);
assert.match(drawer, /Guardando cambios\.\.\./);
assert.match(drawer, /Actualizando perfil\.\.\./);
assert.match(drawer, /error && profile/);
assert.match(drawer, /Reintentar actualización/);
assert.match(drawer, /loading && !profile/, "Skeletons are only valid for an initial load");

assert.match(credit, /result\.profile/);
assert.match(credit, /onRefreshRequested/, "Credit updates must use the same canonical profile refresh");

for (const marker of [
  "runWholesaleGrant",
  "runWholesaleTransition",
  "saveCustomerCommercialCreditAction",
  "suspendCustomerAccountAction",
  "reactivateCustomerAccountAction",
]) {
  const start = actions.indexOf(marker);
  assert.ok(start >= 0, `Missing action ${marker}`);
  const excerpt = actions.slice(start, start + 9000);
  assert.match(excerpt, /profile:\s*await loadCanonicalCustomerProfile/, `${marker} must return a canonical full profile`);
}

assert.match(actions, /async function loadCanonicalCustomerProfile/);
assert.match(manager, /key=\{profileCustomerId \?\? "customer-profile-closed"\}/, "The drawer key must remain stable for the same customer so its tab stays selected");

console.log("Customer profile refresh regression: PASS");
