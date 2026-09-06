import assert from "node:assert/strict";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { buildUtf8BomCsv, csvNumber, spreadsheetSafeText } from "../src/utils/spreadsheet-safety.ts";
import { filterAndSortReceivables } from "../src/utils/receivables-query.ts";
import { alignHistoricalPreview, invalidOriginalAmountMessage, withEffectiveHistoricalValidation } from "../src/utils/historical-receivable-validation.ts";
import { buildReceivablesCsv, buildReceivablesWorkbook } from "../src/utils/accounts-receivable-export.ts";

function payment(id, reference = null) {
  return { id, receivable_id: "r", customer_id: "c", order_id: null, amount: 25, balance_before: 100, balance_after: 75,
    payment_method: "bank_transfer", reference, received_at: "2026-09-05T12:00:00.000Z", note: null, receipt_url: null,
    receipt_public_id: null, recorded_by: null, recorded_by_name: null, recorded_by_email: null, voided_at: null,
    voided_by: null, void_reason: null, created_at: "2026-09-05T12:00:00.000Z" };
}
function row(index, overrides = {}) {
  return { id: `r-${String(index).padStart(3,"0")}`, customer_id: `c-${index}`, order_id: null, invoice_id: null,
    original_amount: 100 + index, total_paid: 25, balance_due: 75 + index, due_date: `2026-09-${String((index%28)+1).padStart(2,"0")}`,
    status: index % 4 === 0 ? "paid" : index % 3 === 0 ? "overdue" : "open", paid_at: null, overdue_at: null,
    payment_received_method: null, payment_received_reference: null, payment_recorded_by: null, payments: [payment(`p-${index}`)],
    created_at: `2026-08-${String((index%28)+1).padStart(2,"0")}T12:00:00.000Z`, updated_at: "2026-09-05T12:00:00.000Z",
    customer_name: `Cliente ${index}`, customer_email: `cliente${index}@example.com`, customer_phone: `9999${index}`,
    order_number: `CZ-${index}`, invoice_number: `000-001-01-${String(index).padStart(8,"0")}`, invoice_status: "emitida", ...overrides };
}

const malicious = ["=HYPERLINK(\"https://bad\")", "+SUM(1,1)", "-1+1", "@SUM(1,1)", "  =cmd|' /C calc'!A0"];
for (const value of malicious) assert.equal(spreadsheetSafeText(value).startsWith("'"), true);
assert.equal(csvNumber(-10), "-10", "numeric values remain numeric through the numeric serializer contract");
const csvFixture = buildUtf8BomCsv([["Creación", "Método", "José López Muñoz Peña"], ...malicious.map(value => [value])]);
assert.equal(csvFixture.charCodeAt(0), 0xfeff);
assert.match(csvFixture, /Creación/);
for (const value of malicious) assert.ok(!csvFixture.includes(`"${value.replaceAll('"','""')}"`), `raw formula-like text leaked: ${value}`);

const rows = Array.from({length: 45}, (_, index) => row(index + 1));
const ordered = filterAndSortReceivables(rows, {filter:"all",query:"",sort:"created",direction:"desc"});
assert.equal(new Set(ordered.map(item => item.id)).size, 45);
const pages = [ordered.slice(0,20), ordered.slice(20,40), ordered.slice(40,60)].flat();
assert.deepEqual(pages.map(item=>item.id), ordered.map(item=>item.id));
assert.equal(filterAndSortReceivables(rows,{filter:"all",query:"00000017",sort:"created",direction:"desc"})[0].id,"r-017");
assert.ok(filterAndSortReceivables(rows,{filter:"overdue",query:"",sort:"due",direction:"asc"}).every(item=>item.status==="overdue"));
assert.deepEqual(filterAndSortReceivables([], {filter:"all",query:"",sort:"created",direction:"desc"}), []);

const zeroRow = { id:"zero",batch_id:"batch",module:"accounts_receivable",row_number:25,original_data:{},normalized_data:{customer_name:"Inversiones Contreras",original_amount:0},validation_status:"valid",validation_messages:[],suggested_customer_id:null,suggested_supplier_id:null,assignment_type:"customer",assignment_status:"pending",assigned_customer_id:null,assigned_supplier_id:null,assigned_by:null,assigned_at:null,apply_status:"failed",apply_error:null,audit_metadata:{},created_at:"",updated_at:"" };
const corrected = withEffectiveHistoricalValidation(zeroRow);
assert.equal(corrected.validation_status,"invalid");
assert.ok(corrected.validation_messages.includes(invalidOriginalAmountMessage));
assert.equal(corrected.apply_status,"failed", "zero rows remain visible and are not auto-cancelled");
const aligned = alignHistoricalPreview({batch_status:"failed",create_customers:1,reuse_customers:0,create_receivables:1,duplicates:0,ambiguous:0,rejected:0,review_required:0,processable:1,rows:[{row_id:"zero",outcome:"create_customer",reason:"Sin errores"}]},[corrected]);
assert.equal(aligned.processable,0); assert.equal(aligned.review_required,1); assert.equal(aligned.rows[0].reason,invalidOriginalAmountMessage);

const exportRow = row(1,{customer_name:"José López Muñoz Peña",invoice_number:"000-001-01-00000001",order_number:"=CMD()",payments:[payment("p-safe","  +SUM(1,1)")]});
const csv = buildReceivablesCsv([exportRow]); assert.equal(csv.charCodeAt(0),0xfeff); assert.match(csv,/José López Muñoz Peña/); assert.match(csv,/000-001-01-00000001/); assert.match(csv,/Creación/); assert.match(csv,/Monto de abono/); assert.ok(!csv.includes('"=CMD()"'));
const summary = {totalPending:exportRow.balance_due,overdueBalance:0,collectedToday:25,collectedThisMonth:25,customersWithDebt:1,dueInSevenDays:0,overdue:0,upcomingReceivables:[],topDebtors:[]};
const buffer = await buildReceivablesWorkbook([exportRow],summary,{status:"all",query:"",sort:"created",direction:"desc"});
const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
assert.deepEqual(workbook.worksheets.map(sheet=>sheet.name),["Resumen","Cuentas","Abonos","Filtros"]);
assert.equal(workbook.getWorksheet("Resumen").getCell("A1").value,"Car Zone Accesorios");
assert.equal(workbook.getWorksheet("Resumen").getCell("A2").value,"Reporte de cuentas por cobrar");
assert.equal(workbook.getWorksheet("Resumen").views[0].ySplit,5);
assert.equal(workbook.getWorksheet("Cuentas").getCell("D2").value,"'=CMD()");
assert.equal(workbook.getWorksheet("Cuentas").getCell("E2").value,"000-001-01-00000001");
assert.equal(workbook.getWorksheet("Cuentas").getColumn(5).numFmt,"@");
assert.equal(workbook.getWorksheet("Cuentas").getCell("P2").value,"'  +SUM(1,1)");
assert.equal(workbook.getWorksheet("Cuentas").getCell("G2").type,ExcelJS.ValueType.Number);
assert.equal(workbook.getWorksheet("Abonos").getCell("G2").value,"'  +SUM(1,1)");
assert.equal(workbook.getWorksheet("Abonos").getCell("E2").type,ExcelJS.ValueType.Number);
assert.equal(workbook.getWorksheet("Abonos").getCell("J2").value,100);
assert.equal(workbook.getWorksheet("Cuentas").views[0].state,"frozen");
assert.ok(workbook.getWorksheet("Cuentas").autoFilter);
assert.equal(workbook.getWorksheet("Cuentas").pageSetup.printTitlesRow,"1:1");
assert.match(workbook.getWorksheet("Cuentas").headerFooter.oddFooter,/&P de &N/);

const managerSource=fs.readFileSync(new URL("../src/components/admin/accounts-receivable-manager.tsx",import.meta.url),"utf8");
const importSource=fs.readFileSync(new URL("../src/components/admin/accounts-receivable-import-manager.tsx",import.meta.url),"utf8");
const sheetSource=fs.readFileSync(new URL("../src/components/admin/accessible-sheet.tsx",import.meta.url),"utf8");
const importServiceSource=fs.readFileSync(new URL("../src/services/supabase/accounts-receivable-import.service.ts",import.meta.url),"utf8");
assert.ok(!managerSource.includes("min-w-[1320px]")); assert.ok(!importSource.includes("min-w-[1180px]"));
assert.equal((managerSource.match(/role=\"table\"/g)??[]).length,1,"one responsive receivables collection");
assert.equal((importSource.match(/role=\"table\"/g)??[]).length,1,"one responsive import collection");
assert.match(managerSource,/min-h-11/); assert.match(importSource,/AccessibleSheet/);
assert.match(managerSource,/Último abono/); assert.match(managerSource,/balance_before/);
assert.match(sheetSource,/useEffectEvent/); assert.ok(!sheetSource.includes("},[onClose])"),"typing must not reset drawer focus");
assert.match(sheetSource,/requestAnimationFrame\(\(\)=>target\?\.focus\(\)\)/,"focus restoration waits for the triggering control to be stable");
assert.match(importServiceSource,/Monto Original debe ser mayor que cero/);

console.log("CxC redesign contract tests passed.");
