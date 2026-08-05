import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const ids = {
  invoice: "959b50af-a759-438e-b614-6837a1053fa7",
  order: "44db4982-e382-4661-b858-e49256d17f56",
  payment: "b546b045-75eb-4ba7-a66c-b88bd0be55d0",
  saleEventV2: "2bcd9b7b-b343-44b6-a450-709cfdaab58a",
  saleOutboxV2: "04fde1d0-b14e-4206-869f-e10203246429",
  cogsEventV2: "087f323f-fe9b-44d3-97ce-6c07a36690f9",
  cogsOutboxV2: "7ef7d0ef-059c-4113-803c-8404d8cefcfd",
  cogsJournal: "939ad70f-d748-4724-a0df-cbefae7feb40",
  saleEventV1: "26c413f2-68df-4a16-818a-155f98394d2f",
  cogsEventV1: "48398a6a-ed3f-4a89-8786-021beaf1549f",
  controlEventV1: "1c4dbd00-f36b-4d9c-87fb-f20d3ca2be6b",
};

const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const outputPath = process.argv[2] ?? "C:/tmp/sale-cod-fee-postflight.json";
if (!base || !key) throw new Error("Missing Supabase read credentials");

let requests = 0;
async function read(table, query = "select=*") {
  requests += 1;
  const response = await fetch(`${base}/rest/v1/${table}?${query}`, {
    method: "GET",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`${table}: ${response.status} ${await response.text()}`);
  return response.json();
}

const [
  accounts, mappings, invoices, orders, payments, movements, events,
  outboxesV1, outboxesV2, journals, lines, periods,
  mappingAudits, supersessions, recoveryAudits,
] = await Promise.all([
  read("accounting_accounts", "select=*&code=in.(1101001,1103001,2101002,4101001,4101002,5101001)"),
  read("accounting_mappings", "select=*&mapping_type=eq.revenue&source_key=eq.sale_cod_fee"),
  read("invoices", `select=*&id=eq.${ids.invoice}`),
  read("orders", `select=*&id=eq.${ids.order}`),
  read("payments", `select=*&id=eq.${ids.payment}`),
  read("inventory_movements", `select=*&reference_type=eq.orders&reference_id=eq.${ids.order}`),
  read("financial_events", `select=*&id=in.(${ids.saleEventV2},${ids.cogsEventV2},${ids.saleEventV1},${ids.cogsEventV1},${ids.controlEventV1})`),
  read("accounting_outbox", "select=*"),
  read("accounting_outbox_v2", `select=*&id=in.(${ids.saleOutboxV2},${ids.cogsOutboxV2})`),
  read("journal_entries", "select=*"),
  read("journal_entry_lines", "select=*"),
  read("accounting_periods", "select=*"),
  read("accounting_mapping_authorization_audit", "select=*"),
  read("accounting_v1_v2_supersessions", "select=*"),
  read("accounting_outbox_recovery_audit", "select=*"),
]);

const invoice = invoices[0];
const order = orders[0];
const payment = payments[0];
const byCode = new Map(accounts.map((account) => [account.code, account]));
const codAccount = byCode.get("4101002");
const byEventId = new Map(events.map((event) => [event.id, event]));
const byOutboxId = new Map(outboxesV2.map((box) => [box.id, box]));
const saleEvent = byEventId.get(ids.saleEventV2);
const saleOutbox = byOutboxId.get(ids.saleOutboxV2);
const cogsOutbox = byOutboxId.get(ids.cogsOutboxV2);
const cogsJournal = journals.find((entry) => entry.id === ids.cogsJournal);
const saleJournals = journals.filter((entry) =>
  entry.id === saleEvent?.journal_entry_id ||
  entry.source_id === ids.invoice ||
  entry.source_id === ids.payment ||
  (entry.source_id === ids.order && entry.id !== ids.cogsJournal)
);
const saleJournal = saleJournals[0];
const saleLines = lines.filter((line) => line.journal_entry_id === saleJournal?.id);
const accountCodeById = new Map(accounts.map((account) => [account.id, account.code]));
const normalizedLines = saleLines.map((line) => ({
  account_code: accountCodeById.get(line.account_id) ?? null,
  debit: Number(line.debit),
  credit: Number(line.credit),
})).sort((a, b) => String(a.account_code).localeCompare(String(b.account_code)));
const expectedLines = [
  { account_code: "1101001", debit: 3002, credit: 0 },
  { account_code: "2101002", debit: 0, credit: 391.3 },
  { account_code: "4101001", debit: 0, credit: 2608.7 },
  { account_code: "4101002", debit: 0, credit: 2 },
];
const movementIds = new Set(movements.map((movement) => movement.id));
const v1OutboxMatches = outboxesV1.filter((box) =>
  [ids.saleEventV1, ids.cogsEventV1, ids.controlEventV1].includes(box.event_id) ||
  [ids.order, ...movementIds].includes(box.source_id)
);
const superseded = (event) => event?.status === "skipped" &&
  Array.isArray(event?.validation_errors) &&
  event.validation_errors.includes("SUPERSEDED_BY_CANONICAL_V2_EVENT") &&
  event.journal_entry_id == null;

const checks = {
  account_exact: accounts.filter((account) => account.code === "4101002").length === 1 && codAccount?.name === "VENTAS POR CONTRAENTREGA" && codAccount?.type === "revenue" && codAccount?.normal_balance === "credit" && codAccount?.is_active === true,
  mapping_exact: mappings.length === 1 && mappings[0]?.account_id === codAccount?.id && mappings[0]?.is_active === true && mappings[0]?.effective_from === "2026-07-16" && mappings[0]?.effective_to == null,
  invoice_intact: invoice?.invoice_number === "000-001-01-00001025" && invoice?.status === "emitida" && Number(invoice?.total) === 3002 && Number(invoice?.cash_on_delivery_fee) === 2,
  order_intact: order?.status === "entregado" && Number(order?.total) === 3002 && Number(order?.cash_on_delivery_fee) === 2,
  payment_intact: payment?.payment_status === "approved" && Number(payment?.amount) === 3002,
  sale_event_reused: saleEvent?.status === "draft_created" && saleEvent?.journal_entry_id === saleJournal?.id,
  sale_outbox_completed: saleOutbox?.status === "completed" && Number(saleOutbox?.attempt_count) === 9 && saleOutbox?.journal_entry_id === saleJournal?.id,
  one_sale_draft: saleJournals.length === 1 && saleJournal?.status === "borrador" && saleJournal?.entry_date === "2026-07-16",
  sale_lines_exact: JSON.stringify(normalizedLines) === JSON.stringify(expectedLines),
  sale_balanced: saleLines.reduce((sum, line) => sum + Number(line.debit), 0) === 3002 && saleLines.reduce((sum, line) => sum + Number(line.credit), 0) === 3002,
  cogs_event_intact: byEventId.get(ids.cogsEventV2)?.status === "posted" && byEventId.get(ids.cogsEventV2)?.journal_entry_id === ids.cogsJournal,
  cogs_outbox_intact: cogsOutbox?.status === "completed" && cogsOutbox?.journal_entry_id === ids.cogsJournal,
  cogs_journal_intact: cogsJournal?.status === "publicada" && cogsJournal?.entry_date === "2026-07-16",
  v1_sale_neutralized: superseded(byEventId.get(ids.saleEventV1)),
  v1_cogs_neutralized: superseded(byEventId.get(ids.cogsEventV1)),
  v1_control_unchanged: byEventId.get(ids.controlEventV1)?.status === "skipped" && byEventId.get(ids.controlEventV1)?.journal_entry_id == null,
  v1_outboxes_zero: v1OutboxMatches.length === 0,
  mapping_audit_once: mappingAudits.filter((row) => row.mapping_key === "revenue:sale_cod_fee" && row.account_code === "4101002").length === 1,
  supersession_audit_twice: supersessions.filter((row) => [ids.saleEventV1, ids.cogsEventV1].includes(row.legacy_event_id)).length === 2,
  recovery_audit_once: recoveryAudits.filter((row) => row.outbox_id === ids.saleOutboxV2).length === 1,
  periods_open_or_absent: periods.every((period) => period.status === "open"),
};

const evidence = {
  ids, accounts, mappings, invoice, order, payment, movements, events,
  outboxesV2, v1OutboxMatches, saleJournal, normalizedLines, cogsJournal,
  mappingAudits, supersessions, recoveryAudits, periods,
};
const hash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
const output = {
  captured_at_utc: new Date().toISOString(),
  captured_at_tegucigalpa: new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Tegucigalpa", dateStyle: "short", timeStyle: "medium" }).format(new Date()),
  safety: { methods: ["GET"], requests, writes_attempted: 0, rpc_calls: 0 },
  ready: Object.values(checks).every(Boolean), checks, hash_sha256: hash, evidence,
};
await writeFile(outputPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ outputPath, captured_at_utc: output.captured_at_utc, safety: output.safety, ready: output.ready, checks, hash_sha256: hash, sale_draft_number: saleJournal?.entry_number ?? null }, null, 2));
if (!output.ready) process.exitCode = 2;
