import "server-only";

import ExcelJS from "exceljs";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import {
  createImportBatch,
  getImportBatchRows,
  setImportBatchStatus,
  stageImportRows,
} from "@/services/supabase/import-foundation.service";
import type {
  HistoricalReceivableApplySummary,
  HistoricalReceivableImportData,
  HistoricalReceivableNormalizedRow,
  HistoricalReceivablePaymentMethod,
  HistoricalReceivableImportStatus,
} from "@/types/accounts-receivable-import";
import type { AssignmentSelectorOption, ImportBatch, ImportPreviewRow, ImportTemplateDefinition } from "@/types/import-foundation";
import { importCellText } from "@/utils/import-excel";
import { buildImportPreviewRow, normalizeImportLabel, sharedImportMaxRows, validateDuplicateImportRows, validateImportRowLimit } from "@/utils/import-validation";

const headerRowNumber = 4;
const currencyTolerance = 0.01;

const statusOptions = ["Pendiente", "Parcial", "Pagada", "Vencida", "Cancelada"];
const paymentMethodOptions = ["Efectivo", "Transferencia", "Tarjeta", "Cheque", "Otro"];

const statusMap: Record<string, HistoricalReceivableImportStatus> = {
  pendiente: "pending",
  parcial: "partial",
  pagada: "paid",
  pagado: "paid",
  vencida: "overdue",
  vencido: "overdue",
  cancelada: "cancelled",
  cancelado: "cancelled",
};

const paymentMethodMap: Record<string, HistoricalReceivablePaymentMethod> = {
  efectivo: "cash",
  transferencia: "bank_transfer",
  "transferencia bancaria": "bank_transfer",
  tarjeta: "card",
  cheque: "check",
  otro: "other",
};

type CustomerLookupRow = {
  id: string;
  business_name: string | null;
  company_name: string | null;
  contact_name: string;
  email: string | null;
  phone: string | null;
  tax_id: string | null;
};

type CustomerMatch = {
  suggestedCustomerId: string | null;
  assignmentStatus: ImportPreviewRow["assignmentStatus"];
  messages: string[];
};

export const accountsReceivableImportTemplate: ImportTemplateDefinition = {
  title: "Car Zone Accesorios - Plantilla oficial de cuentas por cobrar historicas",
  description: `Fecha de generacion: ${new Intl.DateTimeFormat("es-HN", { dateStyle: "long" }).format(new Date())}`,
  sheetName: "Cuentas por cobrar",
  columns: [
    { key: "customer_code", label: "Codigo Cliente", example: "CLI-0001", width: 18 },
    { key: "customer_name", label: "Nombre Cliente", required: true, example: "Repuestos El Centro", width: 32 },
    { key: "customer_email", label: "Correo Cliente", example: "cliente@ejemplo.com", width: 30 },
    { key: "customer_phone", label: "Telefono", example: "9999-9999", width: 18 },
    { key: "customer_tax_id", label: "RTN", example: "08019999999999", width: 20 },
    { key: "invoice_number", label: "Numero Factura", required: true, example: "FAC-2024-001", width: 22 },
    { key: "issue_date", label: "Fecha Emision", required: true, example: "2024-12-15", width: 18 },
    { key: "due_date", label: "Fecha Vencimiento", required: true, example: "2025-01-15", width: 20 },
    { key: "original_amount", label: "Monto Original", required: true, example: 12500, width: 18 },
    { key: "paid_amount", label: "Monto Pagado", required: true, example: 2500, width: 18 },
    { key: "balance_due", label: "Saldo Pendiente", required: true, example: 10000, width: 18 },
    { key: "status", label: "Estado", required: true, dropdownOptions: statusOptions, example: "Parcial", width: 16 },
    { key: "payment_method", label: "Metodo Pago", dropdownOptions: paymentMethodOptions, example: "Transferencia", width: 18 },
    { key: "reference", label: "Referencia", example: "TRX-7788", width: 24 },
    { key: "notes", label: "Observaciones", example: "Saldo historico migrado", width: 42 },
  ],
  examples: [
    {
      customer_code: "",
      customer_name: "Cliente de ejemplo",
      customer_email: "cliente@ejemplo.com",
      customer_phone: "9999-9999",
      customer_tax_id: "08019999999999",
      invoice_number: "FAC-2024-001",
      issue_date: "2024-12-15",
      due_date: "2025-01-15",
      original_amount: 12500,
      paid_amount: 2500,
      balance_due: 10000,
      status: "Parcial",
      payment_method: "Transferencia",
      reference: "TRX-7788",
      notes: "Fila de ejemplo; reemplazar antes de importar.",
    },
  ],
  instructions: [
    "Completa una fila por factura historica. No agregues UUID internos ni modifiques los nombres de columnas.",
    "Nombre Cliente, Numero Factura, Fecha Emision, Fecha Vencimiento, Monto Original, Monto Pagado, Saldo Pendiente y Estado son obligatorios.",
    "Las fechas deben usar formato AAAA-MM-DD.",
    "Monto Original, Monto Pagado y Saldo Pendiente no pueden ser negativos.",
    "Monto Original debe ser mayor o igual que Monto Pagado, y Saldo Pendiente debe coincidir con Monto Original menos Monto Pagado.",
    "El nombre del cliente solo genera sugerencias; nunca asigna automaticamente.",
    "Las filas sin cliente seguro quedan en Pendiente de asignacion y pueden resolverse despues sin vencimiento.",
  ],
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeEmail(value: unknown) {
  const text = cleanText(value).toLowerCase();
  return text.includes("@") ? text : "";
}

function digitsOnly(value: unknown) {
  return cleanText(value).replace(/\D/g, "");
}

function parseDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00-06:00`);
  if (Number.isNaN(date.getTime())) return null;
  return value;
}

function parseAmount(value: string) {
  const normalized = value.replace(/[,\sL]/gi, "");
  if (!normalized) return Number.NaN;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : Number.NaN;
}

function headerKey(value: string): keyof HistoricalReceivableNormalizedRow | null {
  const normalized = normalizeImportLabel(value);
  const map: Record<string, keyof HistoricalReceivableNormalizedRow> = {
    "codigo cliente": "customer_code",
    "nombre cliente": "customer_name",
    "correo cliente": "customer_email",
    telefono: "customer_phone",
    rtn: "customer_tax_id",
    "numero factura": "invoice_number",
    "fecha emision": "issue_date",
    "fecha vencimiento": "due_date",
    "monto original": "original_amount",
    "monto pagado": "paid_amount",
    "saldo pendiente": "balance_due",
    estado: "status",
    "metodo pago": "payment_method",
    referencia: "reference",
    observaciones: "notes",
  };

  return map[normalized] ?? null;
}

function displayCustomerName(customer: CustomerLookupRow) {
  return customer.business_name || customer.company_name || customer.contact_name;
}

function selectorOption(customer: CustomerLookupRow): AssignmentSelectorOption {
  return {
    id: customer.id,
    kind: "customer",
    name: displayCustomerName(customer),
    email: customer.email,
    phone: customer.phone,
    taxId: customer.tax_id,
    code: null,
  };
}

function validateNormalizedRow(rowNumber: number, raw: Record<keyof HistoricalReceivableNormalizedRow, string>) {
  const messages: string[] = [];
  const statusLabel = cleanText(raw.status);
  const paymentLabel = cleanText(raw.payment_method);
  const status = statusMap[normalizeImportLabel(statusLabel)];
  const paymentMethod = paymentLabel ? paymentMethodMap[normalizeImportLabel(paymentLabel)] : null;
  const issueDate = parseDate(cleanText(raw.issue_date));
  const dueDate = parseDate(cleanText(raw.due_date));
  const originalAmount = parseAmount(cleanText(raw.original_amount));
  const paidAmount = parseAmount(cleanText(raw.paid_amount));
  const balanceDue = parseAmount(cleanText(raw.balance_due));

  const required: Array<[keyof HistoricalReceivableNormalizedRow, string]> = [
    ["customer_name", "Nombre Cliente"],
    ["invoice_number", "Numero Factura"],
    ["issue_date", "Fecha Emision"],
    ["due_date", "Fecha Vencimiento"],
    ["original_amount", "Monto Original"],
    ["paid_amount", "Monto Pagado"],
    ["balance_due", "Saldo Pendiente"],
    ["status", "Estado"],
  ];

  for (const [key, label] of required) {
    if (!cleanText(raw[key])) messages.push(`Fila ${rowNumber}: "${label}" es obligatorio.`);
  }

  if (!issueDate) messages.push(`Fila ${rowNumber}: "Fecha Emision" debe tener formato AAAA-MM-DD.`);
  if (!dueDate) messages.push(`Fila ${rowNumber}: "Fecha Vencimiento" debe tener formato AAAA-MM-DD.`);
  if (issueDate && dueDate && dueDate < issueDate) messages.push(`Fila ${rowNumber}: la fecha de vencimiento no puede ser menor que la fecha de emision.`);

  if (!Number.isFinite(originalAmount)) messages.push(`Fila ${rowNumber}: "Monto Original" debe ser numerico.`);
  if (!Number.isFinite(paidAmount)) messages.push(`Fila ${rowNumber}: "Monto Pagado" debe ser numerico.`);
  if (!Number.isFinite(balanceDue)) messages.push(`Fila ${rowNumber}: "Saldo Pendiente" debe ser numerico.`);
  if (Number.isFinite(originalAmount) && originalAmount < 0) messages.push(`Fila ${rowNumber}: "Monto Original" no puede ser negativo.`);
  if (Number.isFinite(paidAmount) && paidAmount < 0) messages.push(`Fila ${rowNumber}: "Monto Pagado" no puede ser negativo.`);
  if (Number.isFinite(balanceDue) && balanceDue < 0) messages.push(`Fila ${rowNumber}: "Saldo Pendiente" no puede ser negativo.`);
  if (Number.isFinite(originalAmount) && Number.isFinite(paidAmount) && originalAmount < paidAmount) messages.push(`Fila ${rowNumber}: "Monto Original" debe ser mayor o igual que "Monto Pagado".`);
  if (Number.isFinite(originalAmount) && Number.isFinite(paidAmount) && Number.isFinite(balanceDue) && Math.abs(originalAmount - paidAmount - balanceDue) > currencyTolerance) {
    messages.push(`Fila ${rowNumber}: "Saldo Pendiente" debe coincidir con Monto Original menos Monto Pagado.`);
  }

  if (!status) messages.push(`Fila ${rowNumber}: "Estado" debe ser Pendiente, Parcial, Pagada, Vencida o Cancelada.`);
  if (paymentLabel && !paymentMethod) messages.push(`Fila ${rowNumber}: "Metodo Pago" debe ser Efectivo, Transferencia, Tarjeta, Cheque u Otro.`);
  if (Number.isFinite(paidAmount) && paidAmount > 0 && !paymentMethod) messages.push(`Fila ${rowNumber}: selecciona "Metodo Pago" cuando exista Monto Pagado.`);

  if (status === "pending" && Number.isFinite(paidAmount) && paidAmount > 0) messages.push(`Fila ${rowNumber}: Estado Pendiente no puede tener Monto Pagado.`);
  if (status === "pending" && Number.isFinite(balanceDue) && Number.isFinite(originalAmount) && Math.abs(balanceDue - originalAmount) > currencyTolerance) messages.push(`Fila ${rowNumber}: Estado Pendiente debe conservar el saldo completo.`);
  if (status === "partial" && (paidAmount <= 0 || balanceDue <= 0)) messages.push(`Fila ${rowNumber}: Estado Parcial requiere monto pagado y saldo pendiente mayores que cero.`);
  if (status === "paid" && Math.abs(balanceDue) > currencyTolerance) messages.push(`Fila ${rowNumber}: Estado Pagada debe tener Saldo Pendiente en cero.`);
  if (status === "overdue" && balanceDue <= 0) messages.push(`Fila ${rowNumber}: Estado Vencida requiere saldo pendiente mayor que cero.`);
  if (status === "cancelled" && Math.abs(balanceDue) > currencyTolerance) messages.push(`Fila ${rowNumber}: Estado Cancelada debe tener Saldo Pendiente en cero.`);

  const normalized: HistoricalReceivableNormalizedRow = {
    customer_code: cleanText(raw.customer_code) || null,
    customer_name: cleanText(raw.customer_name),
    customer_email: normalizeEmail(raw.customer_email) || null,
    customer_phone: digitsOnly(raw.customer_phone) || null,
    customer_tax_id: digitsOnly(raw.customer_tax_id) || null,
    invoice_number: cleanText(raw.invoice_number),
    issue_date: issueDate ?? cleanText(raw.issue_date),
    due_date: dueDate ?? cleanText(raw.due_date),
    original_amount: Number.isFinite(originalAmount) ? originalAmount : 0,
    paid_amount: Number.isFinite(paidAmount) ? paidAmount : 0,
    balance_due: Number.isFinite(balanceDue) ? balanceDue : 0,
    status: status ?? "pending",
    status_label: statusLabel,
    payment_method: paymentMethod,
    payment_label: paymentLabel || null,
    reference: cleanText(raw.reference) || null,
    notes: cleanText(raw.notes) || null,
  };

  return { normalized, messages };
}

async function fetchCustomerMatches(rows: HistoricalReceivableNormalizedRow[]) {
  const emails = [...new Set(rows.map((row) => row.customer_email).filter((value): value is string => Boolean(value)))];
  const phones = [...new Set(rows.map((row) => row.customer_phone).filter((value): value is string => Boolean(value)))];
  const taxIds = [...new Set(rows.map((row) => row.customer_tax_id).filter((value): value is string => Boolean(value)))];
  const names = [...new Set(rows.map((row) => row.customer_name).filter(Boolean).slice(0, 200))];
  const admin = getSupabaseAdminClient();
  const queries: Array<PromiseLike<{ data: CustomerLookupRow[] | null; error: { message: string } | null }>> = [];

  if (emails.length > 0) {
    queries.push(admin.from("customers").select("id, business_name, company_name, contact_name, email, phone, tax_id").in("email", emails).returns<CustomerLookupRow[]>());
  }
  if (phones.length > 0) {
    queries.push(admin.from("customers").select("id, business_name, company_name, contact_name, email, phone, tax_id").in("phone", phones).returns<CustomerLookupRow[]>());
  }
  if (taxIds.length > 0) {
    queries.push(admin.from("customers").select("id, business_name, company_name, contact_name, email, phone, tax_id").in("tax_id", taxIds).returns<CustomerLookupRow[]>());
  }
  for (const name of names.slice(0, 30)) {
    const pattern = `%${name.replace(/[%,()]/g, " ").trim()}%`;
    queries.push(
      admin
        .from("customers")
        .select("id, business_name, company_name, contact_name, email, phone, tax_id")
        .or(`business_name.ilike.${pattern},company_name.ilike.${pattern},contact_name.ilike.${pattern}`)
        .limit(3)
        .returns<CustomerLookupRow[]>(),
    );
  }

  const results = await Promise.all(queries);
  const customers = new Map<string, CustomerLookupRow>();
  for (const result of results) {
    if (result.error) throw new Error(result.error.message);
    for (const customer of result.data ?? []) customers.set(customer.id, customer);
  }

  return [...customers.values()];
}

function matchCustomer(row: HistoricalReceivableNormalizedRow, customers: CustomerLookupRow[]): CustomerMatch {
  const safeMatches = customers.filter((customer) => {
    const emailMatch = row.customer_email && customer.email?.toLowerCase() === row.customer_email;
    const phoneMatch = row.customer_phone && digitsOnly(customer.phone) === row.customer_phone;
    const taxMatch = row.customer_tax_id && digitsOnly(customer.tax_id) === row.customer_tax_id;
    return Boolean(emailMatch || phoneMatch || taxMatch);
  });

  if (safeMatches.length === 1) {
    return {
      suggestedCustomerId: safeMatches[0].id,
      assignmentStatus: "suggested",
      messages: [],
    };
  }

  if (safeMatches.length > 1) {
    return {
      suggestedCustomerId: safeMatches[0].id,
      assignmentStatus: "suggested",
      messages: [],
    };
  }

  const rowName = normalizeImportLabel(row.customer_name);
  const suggested = customers.find((customer) => normalizeImportLabel(displayCustomerName(customer)) === rowName)
    ?? customers.find((customer) => normalizeImportLabel(displayCustomerName(customer)).includes(rowName) || rowName.includes(normalizeImportLabel(displayCustomerName(customer))));

  return {
    suggestedCustomerId: suggested?.id ?? null,
    assignmentStatus: suggested ? "suggested" : "pending",
    messages: [],
  };
}

export async function parseHistoricalAccountsReceivableWorkbook(file: File): Promise<{ rows: ImportPreviewRow[]; errors: string[] }> {
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return { rows: [], errors: ["Solo se aceptan archivos Excel .xlsx."] };
  }

  const workbook = new ExcelJS.Workbook();
  const workbookBuffer = Buffer.from(await file.arrayBuffer()) as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(workbookBuffer);
  const worksheet = workbook.getWorksheet("Cuentas por cobrar") ?? workbook.worksheets[0];
  if (!worksheet) return { rows: [], errors: ["El archivo no contiene una hoja valida."] };

  const headers = new Map<keyof HistoricalReceivableNormalizedRow, number>();
  worksheet.getRow(headerRowNumber).eachCell((cell, columnNumber) => {
    const key = headerKey(importCellText(cell));
    if (key) headers.set(key, columnNumber);
  });

  const requiredHeaders = accountsReceivableImportTemplate.columns.map((column) => column.key as keyof HistoricalReceivableNormalizedRow);
  const headerErrors = requiredHeaders.filter((key) => !headers.has(key)).map((key) => {
    const label = accountsReceivableImportTemplate.columns.find((column) => column.key === key)?.label ?? key;
    return `Falta la columna "${label}".`;
  });
  if (headerErrors.length > 0) return { rows: [], errors: headerErrors };

  const rawRows: Array<{ rowNumber: number; original: Record<string, unknown>; normalized: HistoricalReceivableNormalizedRow; messages: string[] }> = [];
  worksheet.eachRow((worksheetRow, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const raw = {} as Record<keyof HistoricalReceivableNormalizedRow, string>;
    for (const key of requiredHeaders) raw[key] = importCellText(worksheetRow.getCell(headers.get(key)!));
    if (!Object.values(raw).some(Boolean)) return;
    const { normalized, messages } = validateNormalizedRow(rowNumber, raw);
    rawRows.push({ rowNumber, original: raw, normalized, messages });
  });

  const globalErrors: string[] = [];
  const rowLimitError = validateImportRowLimit(rawRows.length, sharedImportMaxRows);
  if (rowLimitError) globalErrors.push(rowLimitError);
  if (rawRows.length === 0) globalErrors.push("El archivo no contiene cuentas por cobrar para importar.");

  const duplicateMessages = validateDuplicateImportRows(
    rawRows.map((row) => ({ rowNumber: row.rowNumber, data: { invoice_number: row.normalized.invoice_number } })),
    ["invoice_number"],
    "Numero Factura",
  );
  const duplicateByRow = new Map<number, string[]>();
  for (const duplicate of duplicateMessages) {
    duplicateByRow.set(duplicate.rowNumber, [...(duplicateByRow.get(duplicate.rowNumber) ?? []), duplicate.message]);
  }

  const customers = await fetchCustomerMatches(rawRows.map((row) => row.normalized));
  const rows = rawRows.map((row) => {
    const match = matchCustomer(row.normalized, customers);
    const validationMessages = [...row.messages, ...(duplicateByRow.get(row.rowNumber) ?? []), ...match.messages];
    return buildImportPreviewRow({
      rowNumber: row.rowNumber,
      originalData: row.original,
      normalizedData: row.normalized,
      validationMessages,
      assignmentType: "customer",
      assignmentStatus: match.assignmentStatus,
      suggestedCustomerId: match.suggestedCustomerId,
      assignedCustomerId: null,
    });
  });

  return { rows, errors: globalErrors };
}

export async function createHistoricalAccountsReceivableImportBatch(file: File, actorId: string) {
  const validation = await parseHistoricalAccountsReceivableWorkbook(file);
  const batchId = await createImportBatch("accounts_receivable", {
    file_name: file.name,
    file_size: file.size,
    import_kind: "historical_accounts_receivable",
  });

  await stageImportRows(batchId, validation.rows);
  const hasErrors = validation.errors.length > 0 || validation.rows.some((row) => row.validationStatus === "invalid");
  const hasPending = validation.rows.some((row) => ["pending", "suggested", "unassigned"].includes(row.assignmentStatus));
  const readyRows = validation.rows.filter((row) => row.validationStatus !== "invalid" && row.assignmentStatus === "confirmed").length;

  await setImportBatchStatus(batchId, hasErrors ? "failed" : hasPending ? "pending_assignment" : "ready", {
    validation_errors: validation.errors,
    ready_rows: readyRows,
    imported_by: actorId,
  });

  return {
    batchId,
    rows: validation.rows,
    errors: validation.errors,
    status: hasErrors ? "failed" : hasPending ? "pending_assignment" : "ready",
  };
}

export async function getHistoricalAccountsReceivableImportData(input: {
  batchId?: string | null;
  canImport: boolean;
  canApply: boolean;
  canAssign: boolean;
  canRollback: boolean;
}): Promise<HistoricalReceivableImportData> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("import_batches")
    .select("id, module, status, created_by, created_at, updated_at, total_rows, pending_rows, validated_rows, applied_rows, failed_rows, rollback_batch_id, rollback_reason, audit_log_id, completed_at, applied_at, rolled_back_at, metadata")
    .eq("module", "accounts_receivable")
    .order("created_at", { ascending: false })
    .limit(20)
    .returns<Array<Omit<ImportBatch, "metadata"> & { metadata: Record<string, unknown> | null }>>();

  if (error) throw new Error(error.message);
  const batches = (data ?? []).map((batch) => ({ ...batch, metadata: batch.metadata ?? {} }));
  const selectedBatch = batches.find((batch) => batch.id === input.batchId) ?? batches[0] ?? null;
  const rows = selectedBatch ? await getImportBatchRows(selectedBatch.id) : [];
  const customerIds = [
    ...new Set(
      rows.flatMap((row) => [row.assigned_customer_id, row.suggested_customer_id]).filter((id): id is string => Boolean(id)),
    ),
  ];
  const assignmentOptions = await getCustomerAssignmentOptions(customerIds);

  return {
    batches,
    selectedBatch,
    rows,
    assignmentOptions,
    canImport: input.canImport,
    canApply: input.canApply,
    canAssign: input.canAssign,
    canRollback: input.canRollback,
  };
}

export async function getCustomerAssignmentOptions(customerIds: string[]): Promise<AssignmentSelectorOption[]> {
  if (customerIds.length === 0) return [];
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("customers")
    .select("id, business_name, company_name, contact_name, email, phone, tax_id")
    .in("id", customerIds)
    .returns<CustomerLookupRow[]>();

  if (error) throw new Error(error.message);
  return (data ?? []).map(selectorOption);
}

export async function assignHistoricalReceivableImportRow(rowId: string, customerId: string) {
  const supabase = await getSupabaseServerClient();
  const { error: assignError } = await supabase.rpc("assign_import_row", {
    target_row_id: rowId,
    target_customer_id: customerId,
    target_supplier_id: null,
    assignment_metadata: { source: "historical_accounts_receivable_import" },
  });
  if (assignError) throw new Error(assignError.message);

  const { error: confirmError } = await supabase.rpc("confirm_import_row_assignment", {
    target_row_id: rowId,
    confirmation_metadata: { source: "historical_accounts_receivable_import" },
  });
  if (confirmError) throw new Error(confirmError.message);
}

export async function cancelHistoricalReceivableImportRow(rowId: string) {
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("cancel_import_row", {
    target_row_id: rowId,
    cancellation_metadata: { source: "historical_accounts_receivable_import" },
  });
  if (error) throw new Error(error.message);
}

export async function applyHistoricalReceivableImportBatch(batchId: string): Promise<HistoricalReceivableApplySummary> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("apply_historical_accounts_receivable_import", { target_batch_id: batchId });
  if (error) throw new Error(error.message);
  const summary = data as Partial<HistoricalReceivableApplySummary> | null;
  return {
    created: Number(summary?.created ?? 0),
    skipped: Number(summary?.skipped ?? 0),
  };
}

export async function rollbackHistoricalReceivableImportBatch(batchId: string, reason: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("rollback_historical_accounts_receivable_import", {
    target_batch_id: batchId,
    rollback_reason: reason || null,
  });
  if (error) throw new Error(error.message);
  return data as { receivables?: number; payments?: number } | null;
}
