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
const outputPath = process.argv[2] ?? "C:/tmp/sale-cod-fee-preflight.json";
if (!base || !key) throw new Error("Missing Supabase read credentials");

let requests = 0;
const methods = [];
async function read(table, query = "select=*") {
  requests += 1;
  methods.push("GET");
  const response = await fetch(`${base}/rest/v1/${table}?${query}`, {
    method: "GET",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`${table}: ${response.status} ${await response.text()}`);
  return response.json();
}

const [
  accounts,
  mappings,
  invoices,
  orders,
  payments,
  movements,
  events,
  outboxesV1,
  outboxesV2,
  journals,
  lines,
  periods,
] = await Promise.all([
  read("accounting_accounts", "select=*"),
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
]);

const invoice = invoices[0];
const order = orders[0];
const payment = payments[0];
const codAccounts = accounts.filter((candidate) => candidate.code === "4101002");
const account = codAccounts[0];
const byEventId = new Map(events.map((event) => [event.id, event]));
const byOutboxId = new Map(outboxesV2.map((outbox) => [outbox.id, outbox]));
const saleOutbox = byOutboxId.get(ids.saleOutboxV2);
const cogsOutbox = byOutboxId.get(ids.cogsOutboxV2);
const cogsJournal = journals.find((entry) => entry.id === ids.cogsJournal);
const movementIds = new Set(movements.map((movement) => movement.id));
const caseEventIds = new Set(events.map((event) => event.id));
const relatedJournals = journals.filter((entry) =>
  entry.id === ids.cogsJournal ||
  entry.source_id === ids.order ||
  entry.source_id === ids.invoice ||
  entry.source_id === ids.payment ||
  caseEventIds.has(entry.source_id) ||
  String(entry.description ?? "").includes("00001025") ||
  (entry.entry_date === "2026-07-16" && lines.some((line) => line.journal_entry_id === entry.id && [3002, 2608.7, 391.3, 2].includes(Number(line.debit) || Number(line.credit))))
);
const relatedJournalIds = new Set(relatedJournals.map((entry) => entry.id));
const relatedLines = lines.filter((line) => relatedJournalIds.has(line.journal_entry_id));
const saleJournals = relatedJournals.filter((entry) => entry.id !== ids.cogsJournal);
const v1OutboxMatches = outboxesV1.filter((box) =>
  [ids.saleEventV1, ids.cogsEventV1, ids.controlEventV1].includes(box.event_id) ||
  [ids.order, ...movementIds].includes(box.source_id)
);

const checks = {
  account_exactly_one: codAccounts.length === 1,
  account_name: account?.name === "VENTAS POR CONTRAENTREGA",
  account_active: account?.is_active === true,
  account_revenue: account?.type === "revenue",
  account_credit_nature: account?.normal_balance === "credit",
  account_leaf: !accounts.some((candidate) => candidate.parent_id === account?.id),
  mapping_absent: mappings.length === 0,
  invoice_exact: invoice?.status === "emitida" && Number(invoice?.total) === 3002 && Number(invoice?.cash_on_delivery_fee) === 2,
  order_exact: order?.status === "entregado" && Number(order?.total) === 3002 && Number(order?.cash_on_delivery_fee) === 2,
  payment_exact: payment?.payment_status === "approved" && Number(payment?.amount) === 3002,
  sale_event_v2_exact: byEventId.get(ids.saleEventV2)?.journal_entry_id == null && byEventId.get(ids.saleEventV2)?.event_purpose === "sale_recognized",
  sale_outbox_exact: saleOutbox?.status === "pending_mapping" && Number(saleOutbox?.attempt_count) === 8 && saleOutbox?.missing_key === "revenue:sale_cod_fee" && saleOutbox?.journal_entry_id == null,
  sale_journals_zero: saleJournals.length === 0,
  cogs_event_posted: byEventId.get(ids.cogsEventV2)?.status === "posted" && byEventId.get(ids.cogsEventV2)?.journal_entry_id === ids.cogsJournal,
  cogs_outbox_completed: cogsOutbox?.status === "completed" && cogsOutbox?.journal_entry_id === ids.cogsJournal,
  cogs_journal_published: cogsJournal?.status === "publicada" && cogsJournal?.entry_date === "2026-07-16",
  v1_sale_safe: byEventId.get(ids.saleEventV1)?.status === "pending" && byEventId.get(ids.saleEventV1)?.journal_entry_id == null,
  v1_cogs_safe: byEventId.get(ids.cogsEventV1)?.status === "ready" && byEventId.get(ids.cogsEventV1)?.journal_entry_id == null,
  v1_control_safe: byEventId.get(ids.controlEventV1)?.status === "skipped" && byEventId.get(ids.controlEventV1)?.journal_entry_id == null,
  v1_outboxes_zero: v1OutboxMatches.length === 0,
  periods_open_or_absent: periods.every((period) => period.status === "open"),
};

const evidence = {
  ids,
  accounts,
  mappings,
  invoice,
  order,
  payment,
  movements,
  events,
  outboxesV2,
  v1OutboxMatches,
  relatedJournals,
  relatedLines,
  periods,
};
const hash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
const output = {
  captured_at_utc: new Date().toISOString(),
  captured_at_tegucigalpa: new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Tegucigalpa", dateStyle: "short", timeStyle: "medium" }).format(new Date()),
  safety: { methods: [...new Set(methods)], requests, writes_attempted: 0, rpc_calls: 0 },
  ready: Object.values(checks).every(Boolean),
  checks,
  hash_sha256: hash,
  evidence,
};
await writeFile(outputPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ outputPath, captured_at_utc: output.captured_at_utc, safety: output.safety, ready: output.ready, checks, hash_sha256: hash }, null, 2));
if (!output.ready) process.exitCode = 2;
