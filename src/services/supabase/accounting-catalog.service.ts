import "server-only";

import ExcelJS from "exceljs";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AccountingAccount, AccountingAccountType, AccountingNormalBalance } from "@/types/accounting";
import type {
  ChartOfAccountsExportData,
  ChartOfAccountsExportRow,
  ChartOfAccountsImportRow,
  ChartOfAccountsImportSummary,
} from "@/types/accounting-catalog";

type ParseResult =
  | { ok: true; rows: ChartOfAccountsImportRow[] }
  | { ok: false; errors: string[]; rows: ChartOfAccountsImportRow[] };

type ExistingAccount = Pick<AccountingAccount, "id" | "code" | "name" | "type" | "parent_id" | "normal_balance" | "is_active" | "description">;

const maxImportRows = 1000;

const requiredHeaders = [
  "Código",
  "Nombre de la cuenta",
  "Tipo",
  "Naturaleza",
  "Cuenta padre",
  "Activa",
  "Descripción",
] as const;

export const chartAccountTypeLabels: Record<AccountingAccountType, string> = {
  asset: "Activo",
  liability: "Pasivo",
  equity: "Patrimonio",
  revenue: "Ingreso",
  cost: "Costo",
  expense: "Gasto",
};

export const chartNormalBalanceLabels: Record<AccountingNormalBalance, string> = {
  debit: "Débito",
  credit: "Crédito",
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeLabel(value: unknown) {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function cellText(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((item) => item.text).join("").trim();
    }
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("result" in value) return cleanText(value.result);
  }

  return cleanText(value);
}

function parseType(value: string): AccountingAccountType | null {
  const normalized = normalizeLabel(value);
  const labels: Record<string, AccountingAccountType> = {
    activo: "asset",
    pasivo: "liability",
    patrimonio: "equity",
    capital: "equity",
    ingreso: "revenue",
    ingresos: "revenue",
    costo: "cost",
    costos: "cost",
    gasto: "expense",
    gastos: "expense",
  };

  return labels[normalized] ?? null;
}

function parseNormalBalance(value: string): AccountingNormalBalance | null {
  const normalized = normalizeLabel(value);
  const labels: Record<string, AccountingNormalBalance> = {
    debito: "debit",
    debe: "debit",
    debit: "debit",
    credito: "credit",
    haber: "credit",
    credit: "credit",
  };

  return labels[normalized] ?? null;
}

function parseActive(value: string): boolean | null {
  const normalized = normalizeLabel(value);
  if (!normalized) return true;

  const truthy = new Set(["si", "true", "1", "x", "activa", "activo"]);
  const falsy = new Set(["no", "false", "0", "inactiva", "inactivo"]);

  if (truthy.has(normalized)) return true;
  if (falsy.has(normalized)) return false;
  return null;
}

function headerKey(value: string) {
  const normalized = normalizeLabel(value);
  const map: Record<string, keyof ChartOfAccountsImportRow | "parent_code"> = {
    codigo: "code",
    "nombre de la cuenta": "name",
    cuenta: "name",
    tipo: "type",
    naturaleza: "normal_balance",
    "cuenta padre": "parent_code",
    activa: "is_active",
    activo: "is_active",
    descripcion: "description",
  };

  return map[normalized] ?? null;
}

async function fetchAllAccounts(): Promise<ExistingAccount[]> {
  const supabase = await getSupabaseServerClient();
  const pageSize = 1000;
  const rows: ExistingAccount[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("accounting_accounts")
      .select("id, code, name, type, parent_id, normal_balance, is_active, description")
      .order("code", { ascending: true })
      .range(from, from + pageSize - 1)
      .returns<ExistingAccount[]>();

    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function fetchMovementFlags(accountIds: string[]) {
  if (accountIds.length === 0) return new Map<string, boolean>();

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_accounting_account_movement_flags", { target_account_ids: accountIds });

  if (error) throw new Error(error.message);

  const rows = Array.isArray(data) ? (data as Array<{ account_id: string; has_movements: boolean }>) : [];
  return new Map(rows.map((row) => [row.account_id, row.has_movements]));
}

function validateParentCycles(rows: ChartOfAccountsImportRow[], existingAccounts: ExistingAccount[]) {
  const errors: string[] = [];
  const byCode = new Map(existingAccounts.map((account) => [account.code, account]));
  const byId = new Map(existingAccounts.map((account) => [account.id, account]));
  const finalParentByCode = new Map<string, string | null>();
  const imported = new Set(rows.map((row) => row.code));

  for (const account of existingAccounts) {
    finalParentByCode.set(account.code, account.parent_id ? byId.get(account.parent_id)?.code ?? null : null);
  }

  for (const row of rows) {
    byCode.set(row.code, {
      id: byCode.get(row.code)?.id ?? row.code,
      code: row.code,
      name: row.name,
      type: row.type,
      parent_id: null,
      normal_balance: row.normal_balance,
      is_active: row.is_active,
      description: row.description,
    });
    finalParentByCode.set(row.code, row.parent_code);
  }

  for (const row of rows) {
    const path = new Set<string>();
    let current: string | null = row.code;

    while (current) {
      if (path.has(current)) {
        errors.push(`Fila ${row.rowNumber}: La cuenta padre crea un ciclo en el catálogo.`);
        break;
      }

      path.add(current);
      current = finalParentByCode.get(current) ?? null;
    }
  }

  return errors.filter((error, index, list) => list.indexOf(error) === index || imported.size === 0);
}

export async function parseAndValidateChartOfAccountsWorkbook(file: File): Promise<ParseResult> {
  const errors: string[] = [];

  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return { ok: false, errors: ["Solo se aceptan archivos Excel .xlsx."], rows: [] };
  }

  const workbook = new ExcelJS.Workbook();
  const workbookBuffer = Buffer.from(await file.arrayBuffer()) as unknown as Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(workbookBuffer);
  const worksheet = workbook.worksheets[0];

  if (!worksheet) {
    return { ok: false, errors: ["El archivo no contiene una hoja válida."], rows: [] };
  }

  const headers = new Map<string, number>();
  worksheet.getRow(1).eachCell((cell, columnNumber) => {
    const key = headerKey(cellText(cell));
    if (key) headers.set(key, columnNumber);
  });

  for (const header of requiredHeaders) {
    const key = headerKey(header);
    if (key && !headers.has(key)) {
      errors.push(`Falta la columna "${header}".`);
    }
  }

  if (errors.length > 0) return { ok: false, errors, rows: [] };

  const rows: ChartOfAccountsImportRow[] = [];
  const seenCodes = new Map<string, number>();

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const rawCode = cellText(row.getCell(headers.get("code")!));
    const rawName = cellText(row.getCell(headers.get("name")!));
    const rawType = cellText(row.getCell(headers.get("type")!));
    const rawNormalBalance = cellText(row.getCell(headers.get("normal_balance")!));
    const rawParent = cellText(row.getCell(headers.get("parent_code")!));
    const rawActive = cellText(row.getCell(headers.get("is_active")!));
    const rawDescription = cellText(row.getCell(headers.get("description")!));

    if (![rawCode, rawName, rawType, rawNormalBalance, rawParent, rawActive, rawDescription].some(Boolean)) {
      return;
    }

    const code = rawCode.toUpperCase();
    const name = rawName;
    const type = parseType(rawType);
    const normalBalance = parseNormalBalance(rawNormalBalance);
    const active = parseActive(rawActive);
    const parentCode = rawParent ? rawParent.toUpperCase() : null;

    if (!code) errors.push(`Fila ${rowNumber}: El código de cuenta está vacío.`);
    if (!name) errors.push(`Fila ${rowNumber}: El nombre de la cuenta está vacío.`);
    if (!type) errors.push(`Fila ${rowNumber}: El tipo de cuenta "${rawType}" no es válido.`);
    if (!normalBalance) errors.push(`Fila ${rowNumber}: La naturaleza "${rawNormalBalance}" no es válida.`);
    if (active === null) errors.push(`Fila ${rowNumber}: El valor de Activa "${rawActive}" no es válido.`);

    if (code) {
      const firstRow = seenCodes.get(code);
      if (firstRow) {
        errors.push(`Fila ${rowNumber}: El código de cuenta "${code}" está duplicado; ya aparece en la fila ${firstRow}.`);
      } else {
        seenCodes.set(code, rowNumber);
      }
    }

    if (code && name && type && normalBalance && active !== null) {
      rows.push({
        rowNumber,
        code,
        name,
        type,
        normal_balance: normalBalance,
        parent_code: parentCode,
        is_active: active,
        description: rawDescription || null,
      });
    }
  });

  if (rows.length === 0) errors.push("El archivo no contiene cuentas para importar.");
  if (rows.length > maxImportRows) errors.push(`El archivo excede el límite de ${maxImportRows} cuentas por importación.`);

  if (errors.length > 0) return { ok: false, errors, rows };

  const existingAccounts = await fetchAllAccounts();
  const existingByCode = new Map(existingAccounts.map((account) => [account.code, account]));
  const existingById = new Map(existingAccounts.map((account) => [account.id, account]));
  const importedByCode = new Map(rows.map((row) => [row.code, row]));
  const existingImportedIds = rows.map((row) => existingByCode.get(row.code)?.id).filter((id): id is string => Boolean(id));
  const movementFlags = await fetchMovementFlags(existingImportedIds);

  for (const row of rows) {
    if (row.parent_code) {
      const importedParent = importedByCode.get(row.parent_code);
      const existingParent = existingByCode.get(row.parent_code);

      if (!importedParent && !existingParent) {
        errors.push(`Fila ${row.rowNumber}: La cuenta padre no existe.`);
      }

      if (importedParent && !importedParent.is_active) {
        errors.push(`Fila ${row.rowNumber}: La cuenta padre está inactiva.`);
      }

      if (!importedParent && existingParent && !existingParent.is_active) {
        errors.push(`Fila ${row.rowNumber}: La cuenta padre está inactiva.`);
      }
    }

    const existing = existingByCode.get(row.code);
    if (!existing) continue;

    const hasMovements = movementFlags.get(existing.id) ?? false;
    const existingParentCode = existing.parent_id ? existingById.get(existing.parent_id)?.code ?? null : null;

    if (hasMovements && row.type !== existing.type) {
      errors.push(`Fila ${row.rowNumber}: No se puede cambiar el tipo de una cuenta con movimientos.`);
    }

    if (hasMovements && row.normal_balance !== existing.normal_balance) {
      errors.push(`Fila ${row.rowNumber}: No se puede cambiar la naturaleza de una cuenta con movimientos.`);
    }

    if (hasMovements && (row.parent_code ?? null) !== existingParentCode) {
      errors.push(`Fila ${row.rowNumber}: No se puede cambiar la cuenta padre de una cuenta con movimientos.`);
    }
  }

  errors.push(...validateParentCycles(rows, existingAccounts));

  return errors.length > 0 ? { ok: false, errors, rows } : { ok: true, rows };
}

export async function applyChartOfAccountsImport(rows: ChartOfAccountsImportRow[], actorId: string): Promise<ChartOfAccountsImportSummary> {
  const supabase = await getSupabaseServerClient();
  const payload = rows.map((row) => ({
    code: row.code,
    name: row.name,
    type: row.type,
    normal_balance: row.normal_balance,
    parent_code: row.parent_code,
    is_active: row.is_active,
    description: row.description,
  }));

  const { data, error } = await supabase.rpc("apply_chart_of_accounts_import", { import_rows: payload, actor_id: actorId });

  if (error) throw new Error(error.message);
  const summary = data as Partial<ChartOfAccountsImportSummary> | null;
  if (
    !summary
    || typeof summary.processed !== "number"
    || typeof summary.created !== "number"
    || typeof summary.updated !== "number"
    || typeof summary.skipped !== "number"
  ) {
    throw new Error("No se recibió confirmación de la importación.");
  }

  return {
    processed: summary.processed,
    created: summary.created,
    updated: summary.updated,
    skipped: summary.skipped,
  };
}

export async function getChartOfAccountsExportData(): Promise<ChartOfAccountsExportData> {
  const accounts = await fetchAllAccounts();
  const byId = new Map(accounts.map((account) => [account.id, account]));

  const rows: ChartOfAccountsExportRow[] = accounts.map((account) => ({
    code: account.code,
    name: account.name,
    type: account.type,
    normal_balance: account.normal_balance,
    parent_code: account.parent_id ? byId.get(account.parent_id)?.code ?? "" : "",
    is_active: account.is_active,
    description: account.description ?? "",
  }));

  return {
    generatedAt: new Date().toISOString(),
    rows,
  };
}

export async function logAccountingCatalogEvent(input: {
  eventType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
}) {
  const supabase = await getSupabaseServerClient();
  await supabase.from("accounting_event_log").insert({
    event_type: input.eventType,
    entity_type: "accounting_accounts",
    entity_id: input.entityId ?? null,
    source_type: "chart_of_accounts",
    source_id: null,
    metadata: input.metadata ?? {},
    created_by: input.createdBy ?? null,
  });
}
