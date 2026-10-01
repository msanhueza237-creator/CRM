import { dashboardDocumentSales } from "../accounting-center/dashboard-sales.ts";
import { isNonSalesEvidence } from "../accounting-center/profitability-issues.ts";
import { salesDocuments } from "./business-analytics.ts";
import { matches, tableResult, type Row } from "./contracts.ts";
import { todayChile } from "./dates.ts";
import type { CopilotSources } from "./sources.ts";
const tax = (v: unknown) => String(v || "").replace(/[^0-9kK]/g, "").toUpperCase();
const money = (v: number) => Math.round(v * 10000) / 10000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export function comparablePurchaseWindows(today: string, days = 30) {
  return { days, current: { from: shift(today, -days), to: shift(today, -1) }, previous: { from: shift(today, -2 * days), to: shift(today, -days - 1) } };
}
export function customerPurchaseSignals(documents: Row[], companies: Row[], today: string, days = 30, observedAt: string | null = null, now = Date.now()) {
  const windows = comparablePurchaseWindows(today, days);
  const companyMap = new Map<string, Row[]>();
  for (const c of new Map(companies.map(c => [String(c.id), c])).values()) { const key = tax(c.rut); companyMap.set(key, [...(companyMap.get(key) || []), c]); }
  const groups = new Map<string, { taxId: string; name: string; companyId: string | null; identity: boolean; currentNet: number; previousNet: number; currentPurchases: number; previousPurchases: number; currentDates: Set<string>; previousDates: Set<string>; creditNotes: number; invalid: number; documentIds: string[]; lastPurchase: string | null }>();
  let excludedByPolicy = 0;
  for (const d of new Map(documents.map(d => [String(d.id), d])).values()) {
    const date = String(d.issued_on);
    if (date < windows.previous.from || date > windows.current.to) continue;
    if (isNonSalesEvidence(d)) { excludedByPolicy++; continue; }
    const t = tax(d.counterpart_tax_id), validTax = /^\d{7,8}[0-9K]$/.test(t), candidates = companyMap.get(t) || [];
    const identity = validTax && candidates.length <= 1, company = candidates.length === 1 ? candidates[0] : undefined;
    const key = `${d.entity_id}:${validTax ? t : `unknown:${d.id}`}`;
    const g = groups.get(key) || { taxId: t, name: String(company?.name || d.counterpart_name || "Identidad pendiente"), companyId: identity && company ? String(company.id) : null, identity,
      currentNet: 0, previousNet: 0, currentPurchases: 0, previousPurchases: 0, currentDates: new Set<string>(), previousDates: new Set<string>(), creditNotes: 0, invalid: 0, documentIds: [], lastPurchase: null };
    g.documentIds.push(String(d.id));
    const amount = dashboardDocumentSales(d), current = date >= windows.current.from;
    if (amount === null) g.invalid++;
    else {
      if (current) g.currentNet += amount; else g.previousNet += amount;
      if (d.document_type === "sales_credit_note") g.creditNotes++;
      else if (["sales_invoice", "sales_exempt_invoice", "sales_receipt", "sales_exempt_receipt"].includes(String(d.document_type)) && amount > 0) {
        if (current) { g.currentPurchases += amount; g.currentDates.add(date); }
        else { g.previousPurchases += amount; g.previousDates.add(date); }
        if (!g.lastPurchase || date > g.lastPurchase) g.lastPurchase = date;
      }
    }
    groups.set(key, g);
  }
  const stamp = Date.parse(observedAt || "");
  const freshness = !Number.isFinite(stamp) || stamp > now ? "unknown" : now - stamp > 86400000 ? "old" : "recent";
  const records = [...groups].map(([key, g]) => {
    const comparable = g.identity && !g.invalid && g.previousPurchases > 0;
    const variation = comparable ? money(100 * (g.currentPurchases - g.previousPurchases) / g.previousPurchases) : null;
    const smallSample = g.previousDates.size < 3;
    const signal = !g.identity ? "Identidad pendiente" : g.invalid ? "Importes pendientes" : !comparable ? "Sin base previa comparable" : freshness !== "recent" ? "Verificar actualización antes de actuar" : smallSample ? "Muestra pequeña; revisar historial" : variation !== null && variation <= -30 ? g.currentDates.size === 0 ? "Sin compra en la ventana actual; revisar continuidad" : "Caída de compras observadas; revisar causa" : "Sin caída de 30% en compras observadas";
    return { customerKey: key, customer: g.name, taxId: g.taxId, currentNet: money(g.currentNet), previousNet: money(g.previousNet), currentPurchases: money(g.currentPurchases), previousPurchases: money(g.previousPurchases), purchaseVariationPercent: variation,
      currentPurchaseDays: g.currentDates.size, previousPurchaseDays: g.previousDates.size, creditNotes: g.creditNotes, invalidDocuments: g.invalid, smallSample, signal,
      lastPurchaseInWindow: g.lastPurchase, daysSinceObservedPurchase: g.lastPurchase ? Math.round((Date.parse(today) - Date.parse(g.lastPurchase)) / 86400000) : null,
      path: g.companyId ? `/empresas/${encodeURIComponent(g.companyId)}` : "/empresas", evidenceDocuments: g.documentIds,
      action: !g.identity ? "Revisar RUT y fichas duplicadas antes de atribuir actividad." : g.invalid || freshness !== "recent" ? "Revisar documentos y actualización del conector antes de contactar." : "Revisar ficha e historial: estacionalidad, compras puntuales y contacto comercial autorizado. No equivale a cliente perdido." };
  }).sort((a, b) => b.previousPurchases - a.previousPurchases || a.customerKey.localeCompare(b.customerKey));
  return { windows, records, freshness, observedAt, generatedAt: new Date(now).toISOString(), excludedByPolicy,
    method: "Dos ventanas consecutivas de igual duración, días calendario completos, hoy excluido. Caída orientativa >=30% en compras emitidas antes de NC; netos y NC separados. Tres días distintos de compra previa como mínimo descriptivo, no prueba estadística. No ajusta estacionalidad ni interpreta ausencia de documentos como pérdida del cliente." };
}
export async function customerPurchaseSignalsTool(source: CopilotSources, args: Row, now = new Date()) {
  const days = Number(args.days || 30), today = todayChile(now), windows = comparablePurchaseWindows(today, days);
  const [documents, companies, connections] = await Promise.all([
    salesDocuments(source, { from: windows.previous.from, to: windows.current.to }),
    source.all("companies?select=id,name,rut&order=id.asc"), source.all("integration_connections?select=last_success_at&provider=eq.facto&limit=1"),
  ]);
  const analysis = customerPurchaseSignals(documents, companies, today, days, typeof connections[0]?.last_success_at === "string" ? connections[0].last_success_at : null, now.getTime());
  const records = analysis.records.filter(r => matches(args.query, r.customer, r.taxId));
  const result = tableResult("get_customer_purchase_signals", "sales", "Señales de compra para revisar, no clientes perdidos", records,
    [{key:"customer",label:"Cliente"},{key:"previousPurchases",label:"Compras previas CLP antes de NC"},{key:"currentPurchases",label:"Compras actuales CLP antes de NC"},{key:"purchaseVariationPercent",label:"Variación %"},{key:"signal",label:"Señal"},{key:"action",label:"Siguiente paso"}], "/empresas", args, [analysis.method, "No son cobros ni rentabilidad. La última compra solo se conoce dentro de las ventanas consultadas."]);
  result.data = { ...result.data as Row, ...analysis, records: result.table!.rows, totalCustomers: records.length };
  result.status = "partial";
  result.coverage.complete = analysis.freshness === "recent" && records.every(r=>!r.invalidDocuments && r.signal!=="Identidad pendiente");
  result.freshness.sourceObservedAt = analysis.observedAt;
  result.summary = `Comparación ${windows.previous.from}–${windows.previous.to} frente a ${windows.current.from}–${windows.current.to}: ${records.length} clientes/grupos observados; mostrando ${result.table!.rows.length}. Fuente ${analysis.observedAt || "sin fecha"}, frescura ${analysis.freshness}. ${analysis.method} Revisar las fichas indicadas; no se enviaron mensajes ni se declaró pérdida de clientes.`;
  for (const r of result.table!.rows) result.evidence.push({label:String(r.customer),path:String(r.path),entityType:"company"});
  return result;
}
