import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildAccountChildrenMap,
  getDescendantAccountIds,
  wouldCreateAccountCycle,
} from "../src/services/accounting/account-hierarchy.ts";

const hierarchy = [
  { id: "root", parent_id: null },
  { id: "child-a", parent_id: "root" },
  { id: "child-b", parent_id: "root" },
  { id: "grandchild", parent_id: "child-a" },
  { id: "unrelated", parent_id: null },
];

const children = buildAccountChildrenMap(hierarchy);
assert.deepEqual([...(children.get("root") ?? [])].sort(), ["child-a", "child-b"]);
assert.deepEqual([...(children.get("child-a") ?? [])], ["grandchild"]);
assert.equal(children.has("unrelated"), false);

assert.deepEqual(
  [...getDescendantAccountIds(hierarchy, "root")].sort(),
  ["child-a", "child-b", "grandchild"],
);
assert.deepEqual([...getDescendantAccountIds(hierarchy, "child-a")], ["grandchild"]);
assert.equal(getDescendantAccountIds(hierarchy, "unrelated").size, 0);

assert.equal(wouldCreateAccountCycle(hierarchy, "root", null), false);
assert.equal(wouldCreateAccountCycle(hierarchy, "root", "unrelated"), false);
assert.equal(wouldCreateAccountCycle(hierarchy, "root", "root"), true);
assert.equal(wouldCreateAccountCycle(hierarchy, "root", "child-a"), true);
assert.equal(wouldCreateAccountCycle(hierarchy, "root", "grandchild"), true);
assert.equal(wouldCreateAccountCycle(hierarchy, "child-a", "child-b"), false);

const malformedCycle = [
  { id: "cycle-a", parent_id: "cycle-b" },
  { id: "cycle-b", parent_id: "cycle-a" },
];
assert.doesNotThrow(() => getDescendantAccountIds(malformedCycle, "cycle-a"));
assert.equal(wouldCreateAccountCycle(malformedCycle, "cycle-a", "cycle-b"), true);

const selectorSource = readFileSync(
  new URL("../src/components/admin/parent-account-combobox.tsx", import.meta.url),
  "utf8",
);
assert.match(selectorSource, /const maxVisibleOptions = 12;/);
assert.match(selectorSource, /account\.is_active/);
assert.match(selectorSource, /getDescendantAccountIds/);
assert.match(selectorSource, /role="combobox"/);
assert.match(selectorSource, /role="listbox"/);
assert.match(selectorSource, /sm:col-span-2/);
assert.match(selectorSource, /max-h-72/);
assert.match(selectorSource, /Sin cuenta padre \/ Cuenta ra/);

const parentServiceSource = readFileSync(
  new URL("../src/services/supabase/accounting-account.service.ts", import.meta.url),
  "utf8",
);
assert.match(parentServiceSource, /import "server-only"/);
assert.match(parentServiceSource, /uuidPattern\.test\(parentId\)/);
assert.match(parentServiceSource, /parent\.is_active/);
assert.match(parentServiceSource, /wouldCreateAccountCycle\(hierarchy, accountId, parentId\)/);

const actionSource = readFileSync(
  new URL("../src/app/admin/contabilidad/actions.ts", import.meta.url),
  "utf8",
);
assert.match(actionSource, /validateAccountingAccountParent/);
assert.match(actionSource, /getAccountingAccountSaveErrorMessage/);

console.log("Account parent hierarchy tests passed.");
