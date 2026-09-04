import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { reportTypeLabels, safeFilename } from "@/lib/commercial-report-domain";
import type { CommercialDashboardData, CommercialFilters, CommercialReportType } from "@/types/commercial-reporting";

type Cell = string | number | boolean;
export type CommercialFileInput = { reportType: CommercialReportType; reportName: string; filters: CommercialFilters; rows: Array<Record<string,Cell>>; dashboard: CommercialDashboardData; generatedAt: string };
const currency = new Intl.NumberFormat("es-HN", { style: "currency", currency: "HNL", minimumFractionDigits: 2 });

function filename(input: CommercialFileInput, extension: "pdf"|"xlsx") { return `${safeFilename(input.reportName)}-${input.filters.from}-${input.filters.to}.${extension}`; }
function logoPath() { return path.join(process.cwd(), "public", "brand", "car-zone-logo-nav.png"); }
function filterSummary(filters: CommercialFilters) {
  return `Canal: ${filters.channel} | Cliente: ${filters.customerType} | Pago: ${filters.paymentMethod} | Venta: ${filters.saleStatus} | Precio especial: ${filters.specialPrice}`;
}
function isMoneyColumn(name: string) { return /monto|vendido|cobrado|pendiente|total|comisi[oó]n|potencial|ganada|ganar|revertida|ticket|precio|diferencia/i.test(name); }

export async function buildCommercialPdf(input: CommercialFileInput) {
  const landscape = Object.keys(input.rows[0] ?? {}).length > 6;
  const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "mm", format: "a4" });
  const logo = await readFile(logoPath());
  doc.addImage(`data:image/png;base64,${logo.toString("base64")}`, "PNG", 14, 8, 42, 14, "car-zone-logo", "FAST");
  doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.text(input.reportName, 62, 14);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.text(`${reportTypeLabels[input.reportType]} · ${input.filters.from} al ${input.filters.to} · America/Tegucigalpa`, 62, 20);
  doc.setDrawColor(228,37,44); doc.setLineWidth(.7); doc.line(14,27,doc.internal.pageSize.getWidth()-14,27);
  doc.setFontSize(9); doc.text(`Ventas: ${input.dashboard.kpis.sales}`,14,33); doc.text(`Vendido: ${currency.format(input.dashboard.kpis.sold)}`,55,33); doc.text(`Cobrado: ${currency.format(input.dashboard.kpis.collected)}`,115,33); doc.text(`Pendiente: ${currency.format(input.dashboard.kpis.outstanding)}`,178,33);
  doc.setFontSize(7); doc.setTextColor(65); doc.text(filterSummary(input.filters),14,38,{maxWidth:doc.internal.pageSize.getWidth()-28}); doc.setTextColor(0);
  const columns = Object.keys(input.rows[0] ?? { Estado: "Sin resultados" });
  const body = input.rows.length ? input.rows.map(row=>columns.map(column=>typeof row[column] === "number" ? Number(row[column]).toLocaleString("es-HN",{minimumFractionDigits:2,maximumFractionDigits:2}) : String(row[column] ?? ""))) : [["Sin resultados para los filtros seleccionados."]];
  autoTable(doc,{ startY:43,head:[columns],body,theme:"grid",margin:{left:14,right:14,bottom:17},styles:{fontSize:columns.length>8?6.5:8,cellPadding:1.7,overflow:"linebreak"},headStyles:{fillColor:[8,15,22],textColor:[255,255,255]},alternateRowStyles:{fillColor:[248,249,250]},didDrawPage:()=>{const page=doc.getCurrentPageInfo().pageNumber;const height=doc.internal.pageSize.getHeight();doc.setFontSize(7);doc.setTextColor(80);doc.text("Car Zone Accesorios - Reporte comercial generado por el sistema",14,height-8);doc.text(`Página ${page}`,doc.internal.pageSize.getWidth()-14,height-8,{align:"right"});}});
  const bytes = Buffer.from(doc.output("arraybuffer"));
  return { bytes, filename: filename(input,"pdf"), contentType:"application/pdf", pageCount:doc.getNumberOfPages() };
}

export async function buildCommercialWorkbook(input: CommercialFileInput) {
  const workbook = new ExcelJS.Workbook(); workbook.creator="Car Zone Accesorios"; workbook.created=new Date(input.generatedAt); workbook.modified=new Date(input.generatedAt);
  const summary = workbook.addWorksheet("Resumen",{views:[{showGridLines:false}]});
  summary.columns=[{width:28},{width:24},{width:24},{width:24}];
  summary.mergeCells("A1:D2"); summary.getCell("A1").value="CAR ZONE ACCESORIOS"; summary.getCell("A1").font={bold:true,size:20,color:{argb:"FFFFFFFF"}}; summary.getCell("A1").fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF080F16"}}; summary.getCell("A1").alignment={vertical:"middle"};
  summary.mergeCells("A4:D4"); summary.getCell("A4").value=input.reportName; summary.getCell("A4").font={bold:true,size:16,color:{argb:"FFE4252C"}};
  summary.addRow([]); summary.addRow(["Período",`${input.filters.from} al ${input.filters.to}`,"Zona horaria","America/Tegucigalpa"]); summary.addRow(["Generado",input.generatedAt,"Tipo",reportTypeLabels[input.reportType]]);
  summary.addRow([]); const kpiHeader=summary.addRow(["Ventas","Monto vendido","Cobrado","Pendiente"]); kpiHeader.eachCell(cell=>{cell.font={bold:true,color:{argb:"FFFFFFFF"}};cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFE4252C"}};});
  const kpi=summary.addRow([input.dashboard.kpis.sales,input.dashboard.kpis.sold,input.dashboard.kpis.collected,input.dashboard.kpis.outstanding]); [2,3,4].forEach(column=>kpi.getCell(column).numFmt='"L" #,##0.00');
  summary.addRow([]); summary.addRow(["Control","Los totales provienen del snapshot autorizado del servidor."]); summary.addRow(["Filas",input.rows.length]);
  summary.getRow(6).font={bold:true}; summary.getRow(7).font={bold:true};
  const data = workbook.addWorksheet("Detalle",{views:[{state:"frozen",ySplit:1}]}); const columns=Object.keys(input.rows[0] ?? {Estado:"Sin resultados"});
  data.columns=columns.map(name=>({header:name,key:name,width:Math.min(38,Math.max(14,name.length+4))}));
  input.rows.forEach(row=>data.addRow(Object.fromEntries(Object.entries(row).map(([name,value])=>[name,/fecha/i.test(name)&&typeof value==="string"&&!Number.isNaN(Date.parse(value))?new Date(value):value])))); data.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,data.rowCount),column:columns.length}};
  data.getRow(1).height=24; data.getRow(1).eachCell(cell=>{cell.font={bold:true,color:{argb:"FFFFFFFF"}};cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF080F16"}};cell.alignment={vertical:"middle"};});
  data.eachRow((row,index)=>{if(index>1&&index%2===0)row.eachCell(cell=>{cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFF7F7F8"}};}); row.eachCell((cell,column)=>{const name=columns[column-1]??"";if(cell.value instanceof Date)cell.numFmt='yyyy-mm-dd';else if(typeof cell.value==="number")cell.numFmt=isMoneyColumn(name)?'"L" #,##0.00':/porcentaje/i.test(name)?'0.00':'#,##0';cell.alignment={vertical:"top",wrapText:true};});});
  const filters=workbook.addWorksheet("Filtros",{views:[{showGridLines:false}]}); filters.columns=[{width:28},{width:45}]; filters.addRow(["Filtro","Valor"]); Object.entries(input.filters).forEach(([key,value])=>filters.addRow([key,String(value??"Todos")])); filters.getRow(1).eachCell(cell=>{cell.font={bold:true,color:{argb:"FFFFFFFF"}};cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFE4252C"}};});
  const bytes=Buffer.from(await workbook.xlsx.writeBuffer()); return {bytes,filename:filename(input,"xlsx"),contentType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",sheetCount:workbook.worksheets.length};
}
