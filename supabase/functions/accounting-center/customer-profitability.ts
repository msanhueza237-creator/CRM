import { profitabilityIssue, isNonSalesEvidence } from "./profitability-issues.ts";
import { dashboardDocumentSales } from "./dashboard-sales.ts";
import { confirmedCostSourceIds } from "./facto-cost-evidence.ts";
import { creditNoteCostReview } from "./credit-note-costs.ts";
import type { CustomerProfitabilityReport, CustomerProfitabilityRow } from "../_shared/customer-profitability-contract.ts";

type Row = Record<string, unknown>;
const money = (n: number) => Math.round(n * 10000) / 10000;
const rut = (v: unknown) => String(v || "").replace(/[^0-9kK]/g, "").toUpperCase();
const amount = (v: unknown) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

// Same document cohort for revenue and cost, with evidence available through the
// period end. Unallocated operating expenses are not customer-level net profit.
export function customerProfitability(documents: Row[], ledger: Row[], accounts: Row[], from: string, to: string, query = "", limit = 10, offset = 0, options: { cohort?: string; ambiguousTaxIds?: string[]; sourceObservedAt?: string | null; now?: number } = {}): CustomerProfitabilityReport {
  const docs = [...new Map(documents.map(d => [String(d.id), d])).values()];
  const accountMap = new Map(accounts.map(a => [String(a.id), a]));
  const lines = [...new Map(ledger.map(l => [String(l.id), l])).values()].filter(l => {
    const e = l.accounting_journal_entries as Row | undefined;
    return e && ["posted", "reversed"].includes(String(e.status)) && String(e.entry_date) <= to;
  });
  const invalidCosts = new Set<string>();
  const costs = new Map<string, number>();
  for (const line of lines) {
    const classification = accountMap.get(String(line.account_id))?.classification;
    if (classification !== "cost_of_sales" && classification !== "inventory") continue;
    const source = String((line.accounting_journal_entries as Row).source_document_id || "");
    const debit = amount(line.debit_clp), credit = amount(line.credit_clp);
    if (debit === null || credit === null) invalidCosts.add(source);
    else if (classification === "cost_of_sales") costs.set(source, money((costs.get(source) || 0) + debit - credit));
  }
  const confirmed = confirmedCostSourceIds(lines, accounts, to);
  const reviews = creditNoteCostReview(docs, lines, accounts, to);
  const notes = new Map(reviews.map(n => [n.id, n]));
  const groups = new Map<string, CustomerProfitabilityRow>();
  const matchingKeys = new Set<string>();
  let excludedDocuments = 0;
  const excludedEvidence: ReturnType<typeof profitabilityIssue>[] = [];
  const search = query.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const taxSearch = /^[\d.kK\-\s]+$/.test(query) && /\d/.test(query) ? rut(query).toLowerCase() : "";
  for (const doc of docs) {
    if (!String(doc.document_type).startsWith("sales_") || String(doc.issued_on) < from || String(doc.issued_on) > to) continue;
    const taxId = rut(doc.counterpart_tax_id);
    const customer = String(doc.counterpart_name || "Cliente sin nombre");
    const haystack = `${customer} ${doc.counterpart_tax_id || ""} ${taxId}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const sales = dashboardDocumentSales(doc);
    if (sales === null && isNonSalesEvidence(doc)) {
      if (!search || haystack.includes(search) || (taxSearch && taxId.toLowerCase().includes(taxSearch))) {
        excludedDocuments++;
        excludedEvidence.push(profitabilityIssue(doc, "sales_validation", `Fuera del cálculo por regla: ${doc.document_type}, estado ${doc.status}. No representa un costo faltante de una venta vigente.`, "Consultar documento excluido; no agregar costos para forzarlo al ranking."));
      }
      continue;
    }
    const id = String(doc.id), identified = /^\d{7,8}[0-9K]$/.test(taxId);
    const key = `${doc.entity_id}:${identified ? taxId : `unknown:${id}`}`;
    if (!search || haystack.includes(search) || (taxSearch && taxId.toLowerCase().includes(taxSearch))) matchingKeys.add(key);
    const row = groups.get(key) || { customerKey: key, customer, taxId: String(doc.counterpart_tax_id || ""), sales: 0, knownCost: 0, knownSales: 0, knownDocuments: 0, cost: null,
      analysis: { status: "unavailable", sales: null, cost: null, grossProfit: null, margin: null },
      grossProfit: null, margin: null, documents: 0, missingCostDocuments: 0, pendingCreditNotes: 0, coverage: 0,
      issues: [], salesComplete: true, excludedSalesDocuments: 0,
      status: identified && !options.ambiguousTaxIds?.includes(taxId) ? "complete" : "unidentified" } as CustomerProfitabilityRow;
    row.documents++;
    if (!identified || options.ambiguousTaxIds?.includes(taxId)) row.issues!.push(profitabilityIssue(doc,
      identified ? "ambiguous_identity" : "identity", identified ? "Varias fichas comerciales comparten este RUT; no se atribuye rentabilidad a una ficha." : "RUT ausente o no identificable; no se agrupa por nombre.",
      "Revisar la identidad del documento y las fichas de Empresas antes de atribuir la venta."));
    if (sales === null) {
      row.salesComplete = false; row.excludedSalesDocuments!++;
      row.issues!.push(profitabilityIssue(doc, "sales_validation", `Venta no calculable: tipo ${doc.document_type}, estado ${doc.status}, calidad ${doc.data_quality}, moneda ${doc.currency}; revisar importes y conversión.`, "Revisar el respaldo y corregir la validación documental con autorización; no tratar el importe como cero."));
      groups.set(key, row); continue;
    }
    row.sales = money(row.sales + sales);
    if (doc.document_type === "sales_credit_note") {
      const note = notes.get(id);
      // Text corrections do not prove a monetary reduction or an inventory reversal.
      if (!note || note.pending || invalidCosts.has(id) || (note.invoiceId && invalidCosts.has(note.invoiceId)) || (note.kind === "text" && sales !== 0)) {
        row.pendingCreditNotes++;
        row.issues!.push(profitabilityIssue(doc, "credit_reversal", invalidCosts.has(id) || (note?.invoiceId && invalidCosts.has(note.invoiceId)) ? "Importes de costo o inventario inválidos en la nota o factura vinculada." : note?.kind === "text" && sales !== 0 ? "Nota de corrección de texto con importe monetario: revisar su alcance antes de calcular costo." : note?.detail || "Referencia o reversa de costo sin evidencia suficiente.", "Abrir la nota y revisar su factura y reversa con el flujo de costo verificado. Confirmar cualquier ajuste contable.", note?.invoiceId));
      }
      else {
        row.knownCost = money(row.knownCost - (note.reversedCost || 0));
        row.knownSales = money(row.knownSales + sales);
        row.knownDocuments++;
      }
    } else if (confirmed.has(id) && !invalidCosts.has(id)) {
      row.knownCost = money(row.knownCost + (costs.get(id) || 0));
      row.knownSales = money(row.knownSales + sales);
      row.knownDocuments++;
    }
    else {
      row.missingCostDocuments++;
      row.issues!.push(profitabilityIssue(doc, "missing_cost", invalidCosts.has(id) ? "Importes de costo o inventario inválidos." : "No hay un costo positivo balanceado con inventario, vinculado y contabilizado hasta el cierre del período.", "Revisar el Libro Diario y los costos ya vinculados. Si falta evidencia, verificarla en Facto antes de importar costo; el costo actual del catálogo o importación no acredita el costo histórico de esta venta."));
    }
    groups.set(key, row);
  }
  // Match the whole customer, not only invoices whose historical name matches.
  const all = [...groups.values()].filter(row => matchingKeys.has(row.customerKey)).map(row => {
    const missing = row.missingCostDocuments + row.pendingCreditNotes + (row.excludedSalesDocuments || 0);
    row.coverage = money(100 * (row.documents - missing) / row.documents);
    if (row.status === "unidentified") return row;
    // Keep exact totals null until all evidence is complete. A partial analysis
    // uses only matched sales/costs; pending returns remain explicitly provisional.
    if (row.knownDocuments > 0) {
      const basisSales = (row.missingCostDocuments || row.excludedSalesDocuments) ? row.knownSales : row.sales;
      const profit = money(basisSales - row.knownCost);
      row.analysis = { status: (row.missingCostDocuments || row.excludedSalesDocuments) ? "partial" : missing ? "provisional" : "verified",
        sales: basisSales, cost: row.knownCost, grossProfit: profit,
        margin: basisSales > 0 ? money(100 * profit / basisSales) : null };
    }
    if (missing) { row.status = "pending"; return row; }
    row.cost = row.knownCost;
    row.grossProfit = money(row.sales - row.cost);
    row.margin = row.sales > 0 ? money(100 * row.grossProfit / row.sales) : null;
    row.status = row.sales > 0 ? "complete" : "no_positive_sales";
    return row;
  });
  const ranked = all.filter(row => row.status === "complete");
  // A sales cohort must keep high-volume customers even when cost is pending.
  const salesRanked = all.filter(row => row.status !== "unidentified" && row.salesComplete !== false && row.sales > 0);
  const tie = (a: CustomerProfitabilityRow, b: CustomerProfitabilityRow) => b.sales - a.sales || a.customerKey.localeCompare(b.customerKey);
  const size = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 10;
  const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const pending = all.filter(row => row.status === "pending" || row.status === "unidentified");
  excludedDocuments += all.reduce((n, r) => n + (r.excludedSalesDocuments || 0), 0);
  const verified = all.filter(r => r.analysis.status === "verified");
  const provisional = all.filter(r => ["partial", "provisional"].includes(r.analysis.status));
  const cohort = options.cohort || "all";
  const selected = cohort === "verified" ? verified : cohort === "provisional" ? provisional : cohort === "uncalculated" ? all.filter(r => r.analysis.status === "unavailable") : cohort === "pending" ? pending : all;
  const documentCount = all.reduce((n, r) => n + r.documents, 0), covered = all.reduce((n, r) => n + r.knownDocuments, 0);
  const now = options.now ?? Date.now(), stamp = Date.parse(options.sourceObservedAt || "");
  const completeness = { universeCustomers: all.length, verifiedCustomers: verified.length, provisionalCustomers: provisional.length,
    uncalculatedCustomers: all.length - verified.length - provisional.length,
    identifiedCustomers: all.filter(r => r.status !== "unidentified").length,
    documents: documentCount, coveredDocuments: covered, documentCoverage: documentCount ? money(100 * covered / documentCount) : null,
    scope: "filtered_universe" as const, generatedAt: new Date(now).toISOString(), sourceObservedAt: Number.isFinite(stamp) ? new Date(stamp).toISOString() : null,
    freshness: !Number.isFinite(stamp) || stamp > now ? "unknown" as const : now - stamp > 86400000 ? "old" as const : "recent" as const,
    sources: ["Documentos financieros validados y excluidos", "Asientos vinculados de costo/inventario", "Referencias y reversas de notas de crédito", "Identidad por RUT; nunca por similitud de nombre"] };
  return {
    excludedEvidence, completeness, cohort, matchedCustomers: selected.length,
    from, to, basis: "document_issue_date", currency: "CLP", customers: all.length, offset: start, limit: size, rankedCustomers: ranked.length, salesCustomers: salesRanked.length,
    pendingCustomers: pending.length, excludedDocuments,
    missingCostDocuments: all.reduce((n, r) => n + r.missingCostDocuments, 0),
    pendingCreditNotes: all.reduce((n, r) => n + r.pendingCreditNotes, 0),
    topProfit: [...ranked].sort((a, b) => b.grossProfit! - a.grossProfit! || tie(a, b)).slice(0, size),
    topMargin: [...ranked].sort((a, b) => b.margin! - a.margin! || tie(a, b)).slice(0, size),
    topSales: [...salesRanked].sort(tie).slice(0, size),
    matches: [...selected].sort(tie).slice(start, start + size),
    pending: pending.sort((a, b) => b.sales - a.sales || tie(a, b)).slice(0, size),
    warnings: ["Utilidad bruta: ventas netas sin IVA menos costos documentados. No es utilidad final ni caja; no distribuye gastos generales.",
      "analysis es un analisis separado: verified usa toda la evidencia; provisional descuenta las notas de venta pero conserva solo reversas de costo verificadas; partial usa exclusivamente knownSales y knownCost de documentos conciliados, excluyendo documentos pendientes. Nunca representa utilidad exacta de toda la empresa cuando falta evidencia.",
      "Ventas y notas de credito por fecha de emision, con costos y reversas vinculados registrados hasta el cierre del periodo. Puede diferir del resultado contable por fechas de contabilizacion o costos sin cliente.",
      ...(pending.length ? [`${pending.length} clientes fuera de los rankings de utilidad/margen por costos, reversas o identidad pendientes. El ranking de ventas conserva clientes identificados con costos pendientes, sin inventar su margen.`] : []),
      ...(excludedDocuments ? [`${excludedDocuments} documentos excluidos por validacion, tipo o importes incompletos.`] : [])],
  };
}
