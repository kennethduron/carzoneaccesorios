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
  HistoricalPayableApplySummary,
  HistoricalPayableImportData,
  HistoricalPayableImportStatus,
  HistoricalPayableNormalizedRow,
  HistoricalPayablePaymentMethod,
} from "@/types/accounts-payable-import";
import type { AssignmentSelectorOption, ImportBatch, ImportPreviewRow, ImportTemplateDefinition } from "@/types/import-foundation";
import { importCellText } from "@/utils/import-excel";
import { normalizeImportLabel, sharedImportMaxRows, validateDuplicateImportRows, validateImportRowLimit } from "@/utils/import-validation";

const headerRowNumber = 4;
const currencyTolerance = 0.01;
const dangerousFormulaPattern = /^[=+\-@\t\r]/;

const statusOptions = ["Pendiente", "Parcial", "Pagada", "Vencida", "Cancelada"];
const currencyOptions = ["HNL", "USD"];
const paymentMethodOptions = ["Efectivo", "Transferencia", "Tarjeta", "Cheque", "Otro"];

const statusMap: Record<string, HistoricalPayableImportStatus> = {
  pendiente: "pending",
  parcial: "partial",
  pagada: "paid",
  pagado: "paid",
  vencida: "overdue",
  vencido: "overdue",
  cancelada: "cancelled",
  cancelado: "cancelled",
};

const paymentMethodMap: Record<string, HistoricalPayablePaymentMethod> = {
  efectivo: "cash",
  transferencia: "bank_transfer",
  "transferencia bancaria": "bank_transfer",
  tarjeta: "card",
  cheque: "check",
  otro: "other",
};

type SupplierLookupRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tax_id: string | null;
};

type SupplierMatch = {
  suggestedSupplierId: string | null;
  assignmentStatus: ImportPreviewRow["assignmentStatus"];
};

export const accountsPayableImportTemplate: ImportTemplateDefinition = {
  title: "Car Zone Accesorios - Plantilla oficial de cuentas por pagar historicas",
  description: `Fecha de generacion: ${new Intl.DateTimeFormat("es-HN", { dateStyle: "long" }).format(new Date())}`,
  sheetName: "Cuentas por pagar",
  columns: [
    { key: "supplier_code", label: "Codigo del proveedor", example: "PROV-0001", width: 22 },
    { key: "supplier_name", label: "Nombre del proveedor", required: true, example: "Distribuidora Atlantida", width: 34 },
    { key: "supplier_tax_id", label: "RTN del proveedor", example: "08019999999999", width: 22 },
    { key: "supplier_email", label: "Correo del proveedor", example: "proveedor@ejemplo.com", width: 30 },
    { key: "supplier_phone", label: "Telefono del proveedor", example: "9999-9999", width: 22 },
    { key: "supplier_invoice_number", label: "Numero de factura del proveedor", required: true, example: "FC-PROV-2024-001", width: 32 },
    { key: "purchase_number", label: "Numero de compra", example: "OC-2024-001", width: 22 },
    { key: "issue_date", label: "Fecha de emision", required: true, example: "2024-12-15", width: 18 },
    { key: "due_date", label: "Fecha de vencimiento", required: true, example: "2025-01-15", width: 20 },
    { key: "original_amount", label: "Monto original", required: true, example: 12500, width: 18 },
    { key: "paid_amount", label: "Monto pagado", required: true, example: 2500, width: 18 },
    { key: "balance_due", label: "Saldo pendiente", required: true, example: 10000, width: 18 },
    { key: "status", label: "Estado", required: true, dropdownOptions: statusOptions, example: "Parcial", width: 16 },
    { key: "currency", label: "Moneda", required: true, dropdownOptions: currencyOptions, example: "HNL", width: 14 },
    { key: "payment_method", label: "Metodo de pago", dropdownOptions: paymentMethodOptions, example: "Transferencia", width: 20 },
    { key: "payment_reference", label: "Referencia de pago", example: "TRX-AP-7788", width: 26 },
    { key: "payment_date", label: "Fecha del pago", example: "2024-12-30", width: 18 },
    { key: "notes", label: "Observaciones", example: "Saldo historico migrado", width: 42 },
  ],
  examples: [
    {
      supplier_code: "",
      supplier_name: "Proveedor de ejemplo",
      supplier_tax_id: "08019999999999",
      supplier_email: "proveedor@ejemplo.com",
      supplier_phone: "9999-9999",
      supplier_invoice_number: "FC-PROV-2024-001",
      purchase_number: "OC-2024-001",
      issue_date: "2024-12-15",
      due_date: "2025-01-15",
      original_amount: 12500,
      paid_amount: 2500,
      balance_due: 10000,
      status: "Parcial",
      currency: "HNL",
      payment_method: "Transferencia",
      payment_reference: "TRX-AP-7788",
      payment_date: "2024-12-30",
      notes: "Fila de ejemplo; reemplazar antes de importar.",
    },
  ],
  instructions: [
    "Completa una fila por factura historica de proveedor. No agregues UUID internos ni cambies los encabezados.",
    "Nombre del proveedor, Numero de factura del proveedor, Fecha de emision, Fecha de vencimiento, Monto original, Monto pagado, Saldo pendiente, Estado y Moneda son obligatorios.",
    "Las fechas deben usar formato AAAA-MM-DD.",
    "Monto original debe ser mayor que cero. Monto pagado y Saldo pendiente no pueden ser negativos.",
    "Saldo pendiente debe coincidir con Monto original menos Monto pagado.",
    "Correo, telefono, RTN y nombre del proveedor solo generan sugerencias; nunca asignan automaticamente.",
    "Las filas sin proveedor confirmado quedan en staging indefinidamente hasta confirmacion manual.",
  ],
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function safeText(value: unknown) {
  const text = cleanText(value);
  return dangerousFormulaPattern.test(text) ? `'${text}` : text;
}

function normalizeEmail(value: unknown) {
  const text = cleanText(value).toLowerCase();
  return text.includes("@") ? text : "";
}

function digitsOnly(value: unknown) {
  return cleanText(value).replace(/\D/g, "");
}

function parseDate(value: string) {
  if (!value) return null;
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

function headerKey(value: string): keyof HistoricalPayableNormalizedRow | null {
  const normalized = normalizeImportLabel(value);
  const map: Record<string, keyof HistoricalPayableNormalizedRow> = {
    "codigo del proveedor": "supplier_code",
    "nombre del proveedor": "supplier_name",
    "rtn del proveedor": "supplier_tax_id",
    "correo del proveedor": "supplier_email",
    "telefono del proveedor": "supplier_phone",
    "numero de factura del proveedor": "supplier_invoice_number",
    "numero de compra": "purchase_number",
    "fecha de emision": "issue_date",
    "fecha de vencimiento": "due_date",
    "monto original": "original_amount",
    "monto pagado": "paid_amount",
    "saldo pendiente": "balance_due",
    estado: "status",
    moneda: "currency",
    "metodo de pago": "payment_method",
    "referencia de pago": "payment_reference",
    "fecha del pago": "payment_date",
    observaciones: "notes",
  };
  return map[normalized] ?? null;
}

function selectorOption(supplier: SupplierLookupRow): AssignmentSelectorOption {
  return {
    id: supplier.id,
    kind: "supplier",
    name: supplier.name,
    email: supplier.email,
    phone: supplier.phone,
    taxId: supplier.tax_id,
    code: null,
  };
}

function validateNormalizedRow(rowNumber: number, raw: Record<keyof HistoricalPayableNormalizedRow, string>) {
  const messages: string[] = [];
  const warnings: string[] = [];
  const statusLabel = cleanText(raw.status);
  const paymentLabel = cleanText(raw.payment_method);
  const currency = cleanText(raw.currency).toUpperCase();
  const status = statusMap[normalizeImportLabel(statusLabel)];
  const paymentMethod = paymentLabel ? paymentMethodMap[normalizeImportLabel(paymentLabel)] : null;
  const issueDate = parseDate(cleanText(raw.issue_date));
  const dueDate = parseDate(cleanText(raw.due_date));
  const paymentDate = parseDate(cleanText(raw.payment_date));
  const originalAmount = parseAmount(cleanText(raw.original_amount));
  const paidAmount = parseAmount(cleanText(raw.paid_amount));
  const balanceDue = parseAmount(cleanText(raw.balance_due));

  const required: Array<[keyof HistoricalPayableNormalizedRow, string]> = [
    ["supplier_name", "Nombre del proveedor"],
    ["supplier_invoice_number", "Numero de factura del proveedor"],
    ["issue_date", "Fecha de emision"],
    ["due_date", "Fecha de vencimiento"],
    ["original_amount", "Monto original"],
    ["paid_amount", "Monto pagado"],
    ["balance_due", "Saldo pendiente"],
    ["status", "Estado"],
    ["currency", "Moneda"],
  ];

  for (const [key, label] of required) {
    if (!cleanText(raw[key])) messages.push(`Fila ${rowNumber}: "${label}" es obligatorio.`);
  }

  if (!issueDate) messages.push(`Fila ${rowNumber}: "Fecha de emision" debe tener formato AAAA-MM-DD.`);
  if (!dueDate) messages.push(`Fila ${rowNumber}: "Fecha de vencimiento" debe tener formato AAAA-MM-DD.`);
  if (cleanText(raw.payment_date) && !paymentDate) messages.push(`Fila ${rowNumber}: "Fecha del pago" debe tener formato AAAA-MM-DD.`);
  if (issueDate && dueDate && dueDate < issueDate) warnings.push(`Fila ${rowNumber}: advertencia, la fecha de vencimiento es anterior a la fecha de emision.`);

  if (!Number.isFinite(originalAmount)) messages.push(`Fila ${rowNumber}: "Monto original" debe ser numerico.`);
  if (!Number.isFinite(paidAmount)) messages.push(`Fila ${rowNumber}: "Monto pagado" debe ser numerico.`);
  if (!Number.isFinite(balanceDue)) messages.push(`Fila ${rowNumber}: "Saldo pendiente" debe ser numerico.`);
  if (Number.isFinite(originalAmount) && originalAmount <= 0) messages.push(`Fila ${rowNumber}: "Monto original" debe ser mayor que cero.`);
  if (Number.isFinite(paidAmount) && paidAmount < 0) messages.push(`Fila ${rowNumber}: "Monto pagado" no puede ser negativo.`);
  if (Number.isFinite(balanceDue) && balanceDue < 0) messages.push(`Fila ${rowNumber}: "Saldo pendiente" no puede ser negativo.`);
  if (Number.isFinite(originalAmount) && Number.isFinite(paidAmount) && paidAmount > originalAmount) messages.push(`Fila ${rowNumber}: "Monto pagado" no puede exceder "Monto original".`);
  if (Number.isFinite(originalAmount) && Number.isFinite(paidAmount) && Number.isFinite(balanceDue) && Math.abs(originalAmount - paidAmount - balanceDue) > currencyTolerance) {
    messages.push(`Fila ${rowNumber}: "Saldo pendiente" debe coincidir con Monto original menos Monto pagado.`);
  }

  if (!status) messages.push(`Fila ${rowNumber}: "Estado" debe ser Pendiente, Parcial, Pagada, Vencida o Cancelada.`);
  if (!currencyOptions.includes(currency)) messages.push(`Fila ${rowNumber}: "Moneda" debe ser HNL o USD.`);
  if (paymentLabel && !paymentMethod) messages.push(`Fila ${rowNumber}: "Metodo de pago" debe ser Efectivo, Transferencia, Tarjeta, Cheque u Otro.`);
  if (Number.isFinite(paidAmount) && paidAmount > 0 && !paymentMethod) messages.push(`Fila ${rowNumber}: selecciona "Metodo de pago" cuando exista Monto pagado.`);

  if (status === "pending" && Number.isFinite(paidAmount) && paidAmount > 0) messages.push(`Fila ${rowNumber}: Estado Pendiente no puede tener Monto pagado.`);
  if (status === "pending" && Number.isFinite(balanceDue) && Number.isFinite(originalAmount) && Math.abs(balanceDue - originalAmount) > currencyTolerance) messages.push(`Fila ${rowNumber}: Estado Pendiente debe conservar el saldo completo.`);
  if (status === "partial" && (paidAmount <= 0 || balanceDue <= 0)) messages.push(`Fila ${rowNumber}: Estado Parcial requiere monto pagado y saldo pendiente mayores que cero.`);
  if (status === "paid" && Math.abs(balanceDue) > currencyTolerance) messages.push(`Fila ${rowNumber}: Estado Pagada debe tener Saldo pendiente en cero.`);
  if (status === "overdue" && balanceDue <= 0) messages.push(`Fila ${rowNumber}: Estado Vencida requiere saldo pendiente mayor que cero.`);
  if (status === "cancelled" && Math.abs(balanceDue) > currencyTolerance) messages.push(`Fila ${rowNumber}: Estado Cancelada debe tener Saldo pendiente en cero.`);

  const normalized: HistoricalPayableNormalizedRow = {
    supplier_code: safeText(raw.supplier_code) || null,
    supplier_name: safeText(raw.supplier_name),
    supplier_tax_id: digitsOnly(raw.supplier_tax_id) || null,
    supplier_email: normalizeEmail(raw.supplier_email) || null,
    supplier_phone: digitsOnly(raw.supplier_phone) || null,
    supplier_invoice_number: safeText(raw.supplier_invoice_number),
    purchase_number: safeText(raw.purchase_number) || null,
    issue_date: issueDate ?? cleanText(raw.issue_date),
    due_date: dueDate ?? cleanText(raw.due_date),
    original_amount: Number.isFinite(originalAmount) ? originalAmount : 0,
    paid_amount: Number.isFinite(paidAmount) ? paidAmount : 0,
    balance_due: Number.isFinite(balanceDue) ? balanceDue : 0,
    status: status ?? "pending",
    status_label: statusLabel,
    currency: currency || "HNL",
    payment_method: paymentMethod,
    payment_label: paymentLabel || null,
    payment_reference: safeText(raw.payment_reference) || null,
    payment_date: paymentDate,
    notes: safeText(raw.notes) || null,
  };

  return { normalized, messages, warnings };
}

async function fetchSupplierMatches(rows: HistoricalPayableNormalizedRow[]) {
  const emails = [...new Set(rows.map((row) => row.supplier_email).filter((value): value is string => Boolean(value)))];
  const phones = [...new Set(rows.map((row) => row.supplier_phone).filter((value): value is string => Boolean(value)))];
  const taxIds = [...new Set(rows.map((row) => row.supplier_tax_id).filter((value): value is string => Boolean(value)))];
  const names = [...new Set(rows.map((row) => row.supplier_name).filter(Boolean).slice(0, 200))];
  const admin = getSupabaseAdminClient();
  const queries: Array<PromiseLike<{ data: SupplierLookupRow[] | null; error: { message: string } | null }>> = [];

  if (emails.length > 0) queries.push(admin.from("suppliers").select("id, name, email, phone, tax_id").in("email", emails).returns<SupplierLookupRow[]>());
  if (phones.length > 0) queries.push(admin.from("suppliers").select("id, name, email, phone, tax_id").in("phone", phones).returns<SupplierLookupRow[]>());
  if (taxIds.length > 0) queries.push(admin.from("suppliers").select("id, name, email, phone, tax_id").in("tax_id", taxIds).returns<SupplierLookupRow[]>());
  for (const name of names.slice(0, 30)) {
    const pattern = `%${name.replace(/[%,()]/g, " ").trim()}%`;
    queries.push(admin.from("suppliers").select("id, name, email, phone, tax_id").ilike("name", pattern).limit(3).returns<SupplierLookupRow[]>());
  }

  const results = await Promise.all(queries);
  const suppliers = new Map<string, SupplierLookupRow>();
  for (const result of results) {
    if (result.error) throw new Error(result.error.message);
    for (const supplier of result.data ?? []) suppliers.set(supplier.id, supplier);
  }
  return [...suppliers.values()];
}

function matchSupplier(row: HistoricalPayableNormalizedRow, suppliers: SupplierLookupRow[]): SupplierMatch {
  const safeMatches = suppliers.filter((supplier) => {
    const emailMatch = row.supplier_email && supplier.email?.toLowerCase() === row.supplier_email;
    const phoneMatch = row.supplier_phone && digitsOnly(supplier.phone) === row.supplier_phone;
    const taxMatch = row.supplier_tax_id && digitsOnly(supplier.tax_id) === row.supplier_tax_id;
    return Boolean(emailMatch || phoneMatch || taxMatch);
  });

  if (safeMatches.length > 0) {
    return { suggestedSupplierId: safeMatches[0].id, assignmentStatus: "suggested" };
  }

  const rowName = normalizeImportLabel(row.supplier_name);
  const suggested =
    suppliers.find((supplier) => normalizeImportLabel(supplier.name) === rowName) ??
    suppliers.find((supplier) => normalizeImportLabel(supplier.name).includes(rowName) || rowName.includes(normalizeImportLabel(supplier.name)));

  return { suggestedSupplierId: suggested?.id ?? null, assignmentStatus: suggested ? "suggested" : "pending" };
}

export async function parseHistoricalAccountsPayableWorkbook(file: File): Promise<{ rows: ImportPreviewRow[]; errors: string[] }> {
  if (!file.name.toLowerCase().endsWith(".xlsx")) return { rows: [], errors: ["Solo se aceptan archivos Excel .xlsx."] };

  const workbook = new ExcelJS.Workbook();
  const workbookBuffer = Buffer.from(await file.arrayBuffer()) as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(workbookBuffer);
  const worksheet = workbook.getWorksheet("Cuentas por pagar") ?? workbook.worksheets[0];
  if (!worksheet) return { rows: [], errors: ["El archivo no contiene una hoja valida."] };

  const headers = new Map<keyof HistoricalPayableNormalizedRow, number>();
  worksheet.getRow(headerRowNumber).eachCell((cell, columnNumber) => {
    const key = headerKey(importCellText(cell));
    if (key) headers.set(key, columnNumber);
  });

  const requiredHeaders = accountsPayableImportTemplate.columns.map((column) => column.key as keyof HistoricalPayableNormalizedRow);
  const headerErrors = requiredHeaders.filter((key) => !headers.has(key)).map((key) => {
    const label = accountsPayableImportTemplate.columns.find((column) => column.key === key)?.label ?? key;
    return `Falta la columna "${label}".`;
  });
  if (headerErrors.length > 0) return { rows: [], errors: headerErrors };

  const rawRows: Array<{ rowNumber: number; original: Record<string, unknown>; normalized: HistoricalPayableNormalizedRow; messages: string[]; warnings: string[] }> = [];
  worksheet.eachRow((worksheetRow, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const raw = {} as Record<keyof HistoricalPayableNormalizedRow, string>;
    for (const key of requiredHeaders) raw[key] = importCellText(worksheetRow.getCell(headers.get(key)!));
    if (!Object.values(raw).some(Boolean)) return;
    const { normalized, messages, warnings } = validateNormalizedRow(rowNumber, raw);
    rawRows.push({ rowNumber, original: raw, normalized, messages, warnings });
  });

  const globalErrors: string[] = [];
  const rowLimitError = validateImportRowLimit(rawRows.length, sharedImportMaxRows);
  if (rowLimitError) globalErrors.push(rowLimitError);
  if (rawRows.length === 0) globalErrors.push("El archivo no contiene cuentas por pagar para importar.");

  const duplicateMessages = validateDuplicateImportRows(
    rawRows.map((row) => ({ rowNumber: row.rowNumber, data: { supplier_name: row.normalized.supplier_name, supplier_invoice_number: row.normalized.supplier_invoice_number } })),
    ["supplier_name", "supplier_invoice_number"],
    "Proveedor + factura",
  );
  const duplicateByRow = new Map<number, string[]>();
  for (const duplicate of duplicateMessages) duplicateByRow.set(duplicate.rowNumber, [...(duplicateByRow.get(duplicate.rowNumber) ?? []), duplicate.message]);

  const suppliers = await fetchSupplierMatches(rawRows.map((row) => row.normalized));
  const rows = rawRows.map((row) => {
    const match = matchSupplier(row.normalized, suppliers);
    const errors = [...row.messages, ...(duplicateByRow.get(row.rowNumber) ?? [])];
    return {
      rowNumber: row.rowNumber,
      originalData: row.original,
      normalizedData: { ...row.normalized, warnings: row.warnings },
      validationStatus: errors.length > 0 ? "invalid" : row.warnings.length > 0 ? "warning" : "valid",
      validationMessages: [...errors, ...row.warnings],
      assignmentType: "supplier",
      assignmentStatus: match.assignmentStatus,
      applyStatus: "pending",
      suggestedSupplierId: match.suggestedSupplierId,
      assignedSupplierId: null,
    } satisfies ImportPreviewRow;
  });

  return { rows, errors: globalErrors };
}

export async function createHistoricalAccountsPayableImportBatch(file: File, actorId: string) {
  const validation = await parseHistoricalAccountsPayableWorkbook(file);
  const batchId = await createImportBatch("accounts_payable", {
    file_name: file.name,
    file_size: file.size,
    import_kind: "historical_accounts_payable",
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

  return { batchId, rows: validation.rows, errors: validation.errors, status: hasErrors ? "failed" : hasPending ? "pending_assignment" : "ready" };
}

export async function getHistoricalAccountsPayableImportData(input: {
  batchId?: string | null;
  canImport: boolean;
  canApply: boolean;
  canAssign: boolean;
  canRollback: boolean;
}): Promise<HistoricalPayableImportData> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("import_batches")
    .select("id, module, status, created_by, created_at, updated_at, total_rows, pending_rows, validated_rows, applied_rows, failed_rows, rollback_batch_id, rollback_reason, audit_log_id, completed_at, applied_at, rolled_back_at, metadata")
    .eq("module", "accounts_payable")
    .order("created_at", { ascending: false })
    .limit(20)
    .returns<Array<Omit<ImportBatch, "metadata"> & { metadata: Record<string, unknown> | null }>>();

  if (error) throw new Error(error.message);
  const batches = (data ?? []).map((batch) => ({ ...batch, metadata: batch.metadata ?? {} }));
  const selectedBatch = batches.find((batch) => batch.id === input.batchId) ?? batches[0] ?? null;
  const rows = selectedBatch ? await getImportBatchRows(selectedBatch.id) : [];
  const supplierIds = [...new Set(rows.flatMap((row) => [row.assigned_supplier_id, row.suggested_supplier_id]).filter((id): id is string => Boolean(id)))];
  const assignmentOptions = await getSupplierAssignmentOptions(supplierIds);

  return { batches, selectedBatch, rows, assignmentOptions, canImport: input.canImport, canApply: input.canApply, canAssign: input.canAssign, canRollback: input.canRollback };
}

export async function getSupplierAssignmentOptions(supplierIds: string[]): Promise<AssignmentSelectorOption[]> {
  if (supplierIds.length === 0) return [];
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.from("suppliers").select("id, name, email, phone, tax_id").in("id", supplierIds).returns<SupplierLookupRow[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(selectorOption);
}

export async function assignHistoricalPayableImportRow(rowId: string, supplierId: string) {
  const supabase = await getSupabaseServerClient();
  const { error: assignError } = await supabase.rpc("assign_import_row", {
    target_row_id: rowId,
    target_customer_id: null,
    target_supplier_id: supplierId,
    assignment_metadata: { source: "historical_accounts_payable_import" },
  });
  if (assignError) throw new Error(assignError.message);

  const { error: confirmError } = await supabase.rpc("confirm_import_row_assignment", {
    target_row_id: rowId,
    confirmation_metadata: { source: "historical_accounts_payable_import" },
  });
  if (confirmError) throw new Error(confirmError.message);
}

export async function cancelHistoricalPayableImportRow(rowId: string) {
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("cancel_import_row", {
    target_row_id: rowId,
    cancellation_metadata: { source: "historical_accounts_payable_import" },
  });
  if (error) throw new Error(error.message);
}

export async function applyHistoricalPayableImportBatch(batchId: string): Promise<HistoricalPayableApplySummary> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("apply_historical_accounts_payable_import", { target_batch_id: batchId });
  if (error) throw new Error(error.message);
  const summary = data as Partial<HistoricalPayableApplySummary> | null;
  return {
    invoices: Number(summary?.invoices ?? 0),
    payables: Number(summary?.payables ?? 0),
    payments: Number(summary?.payments ?? 0),
    skipped: Number(summary?.skipped ?? 0),
  };
}

export async function rollbackHistoricalPayableImportBatch(batchId: string, reason: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("rollback_historical_accounts_payable_import", {
    target_batch_id: batchId,
    rollback_reason: reason || null,
  });
  if (error) throw new Error(error.message);
  return data as { invoices?: number; payables?: number; payments?: number } | null;
}
