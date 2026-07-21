import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = read("supabase/migrations/202607210001_accounting_draft_workflow.sql");
const hardening = read("supabase/migrations/202607210002_harden_accounting_journal_writes.sql");
const actions = read("src/app/admin/contabilidad/actions.ts");
const editor = read("src/components/admin/journal-entry-editor.tsx");
const list = read("src/components/admin/accounting-manager.tsx");
const page = read("src/app/admin/contabilidad/partidas/[id]/editar/page.tsx");
const generator = read("src/services/accounting/journal-draft-generator.ts");
const payableLineBuilder = read("src/services/accounting/purchase-payable-journal-lines.ts");

for (const rpc of [
  "create_manual_journal_draft",
  "create_journal_draft_from_financial_event",
  "update_journal_draft",
  "recalculate_journal_draft_from_source",
  "post_journal_entry",
  "reverse_journal_entry",
]) {
  assert.match(workflow, new RegExp(`create or replace function public\\.${rpc}`, "i"), `${rpc} must exist`);
}
assert.match(workflow, /for update/i, "mutating RPCs must use row locks");
assert.match(workflow, /expected_version/i, "optimistic concurrency must be enforced");
assert.match(workflow, /total_debit[^;]+total_credit/is, "balance must be validated in SQL");
assert.match(workflow, /accounting_entry_updated/);
assert.match(workflow, /accounting_line_added/);
assert.match(workflow, /accounting_line_updated/);
assert.match(workflow, /accounting_line_removed/);
assert.match(workflow, /accounting_entry_published/);
assert.match(workflow, /journal_entry\.reversed/);
assert.match(workflow, /fiscal_breakdown_status/);
assert.match(workflow, /purchase_tax/);

assert.match(hardening, /revoke insert, update, delete on public\.journal_entries from authenticated/i);
assert.match(hardening, /revoke insert, update, delete on public\.journal_entry_lines from authenticated/i);
assert.doesNotMatch(actions, /\.from\("journal_entries"\)\s*\.(?:insert|update|delete)/s);
assert.doesNotMatch(actions, /\.from\("journal_entry_lines"\)\s*\.(?:insert|update|delete)/s);
assert.match(actions, /requirePermission\("accounting:edit_draft_entries"\)/);
assert.match(actions, /rpc\("update_journal_draft"/);
assert.match(actions, /rpc\("recalculate_journal_draft_from_source"/);
assert.match(actions, /rpc\("post_journal_entry"/);
assert.match(generator, /rpc\("create_journal_draft_from_financial_event"/);
assert.match(generator, /buildPurchasePayableJournalLines/);
assert.match(payableLineBuilder, /missing_tax_account/);

assert.match(page, /requirePermission\("accounting:edit_draft_entries"\)/);
assert.match(list, />\s*Editar\s*</);
assert.match(editor, /Motivo obligatorio/);
assert.match(editor, /Recalcular desde origen/);
assert.match(editor, /La partida está balanceada/);
assert.match(editor, /Las partidas publicadas, reversadas o anuladas son inmutables/);
assert.match(editor, /no cambia la cuenta por pagar, la compra ni la factura del proveedor/);

console.log("Accounting draft workflow structure tests passed.");
