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
export function customerProfitability(documents: Row[], ledger: Row[], accounts: Row[], from: string, to: string, query = "", limit = 10): CustomerProfitabilityReport {
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
  const search = query.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const taxSearch = /^[\d.kK\-\s]+$/.test(query) && /\d/.test(query) ? rut(query).toLowerCase() : "";
  for (const doc of docs) {
    if (!String(doc.document_type).startsWith("sales_") || String(doc.issued_on) < from || String(doc.issued_on) > to) continue;
    const taxId = rut(doc.counterpart_tax_id);
    const customer = String(doc.counterpart_name || "Cliente sin nombre");
    const haystack = `${customer} ${doc.counterpart_tax_id || ""} ${taxId}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const sales = dashboardDocumentSales(doc);
    if (sales === null) {
      if (!search || haystack.includes(search) || (taxSearch && taxId.toLowerCase().includes(taxSearch))) excludedDocuments++;
      continue;
    }
    const id = String(doc.id), identified = /^\d{7,8}[0-9K]$/.test(taxId);
    const key = `${doc.entity_id}:${identified ? taxId : `unknown:${id}`}`;
    if (!search || haystack.includes(search) || (taxSearch && taxId.toLowerCase().includes(taxSearch))) matchingKeys.add(key);
    const row = groups.get(key) || { customerKey: key, customer, taxId: String(doc.counterpart_tax_id || ""), sales: 0, knownCost: 0, cost: null,
      grossProfit: null, margin: null, documents: 0, missingCostDocuments: 0, pendingCreditNotes: 0, coverage: 0,
      status: identified ? "complete" : "unidentified" } as CustomerProfitabilityRow;
    row.sales = money(row.sales + sales);
    row.documents++;
    if (doc.document_type === "sales_credit_note") {
      const note = notes.get(id);
      // Text corrections do not prove a monetary reduction or an inventory reversal.
      if (!note || note.pending || invalidCosts.has(id) || (note.invoiceId && invalidCosts.has(note.invoiceId)) || (note.kind === "text" && sales !== 0)) row.pendingCreditNotes++;
      else row.knownCost = money(row.knownCost - (note.reversedCost || 0));
    } else if (confirmed.has(id) && !invalidCosts.has(id)) row.knownCost = money(row.knownCost + (costs.get(id) || 0));
    else row.missingCostDocuments++;
    groups.set(key, row);
  }
  // Match the whole customer, not only invoices whose historical name matches.
  const all = [...groups.values()].filter(row => matchingKeys.has(row.customerKey)).map(row => {
    const missing = row.missingCostDocuments + row.pendingCreditNotes;
    row.coverage = money(100 * (row.documents - missing) / row.documents);
    if (row.status === "unidentified") return row;
    if (missing) { row.status = "pending"; return row; }
    row.cost = row.knownCost;
    row.grossProfit = money(row.sales - row.cost);
    row.margin = row.sales > 0 ? money(100 * row.grossProfit / row.sales) : null;
    row.status = row.sales > 0 ? "complete" : "no_positive_sales";
    return row;
  });
  const ranked = all.filter(row => row.status === "complete");
  // A sales cohort must keep high-volume customers even when cost is pending.
  const salesRanked = all.filter(row => row.status !== "unidentified" && row.sales > 0);
  const tie = (a: CustomerProfitabilityRow, b: CustomerProfitabilityRow) => b.sales - a.sales || a.customerKey.localeCompare(b.customerKey);
  const size = Math.max(1, Math.min(100, limit));
  const pending = all.filter(row => row.status === "pending" || row.status === "unidentified");
  return {
    from, to, basis: "document_issue_date", currency: "CLP", customers: all.length, rankedCustomers: ranked.length, salesCustomers: salesRanked.length,
    pendingCustomers: pending.length, excludedDocuments,
    missingCostDocuments: all.reduce((n, r) => n + r.missingCostDocuments, 0),
    pendingCreditNotes: all.reduce((n, r) => n + r.pendingCreditNotes, 0),
    topProfit: [...ranked].sort((a, b) => b.grossProfit! - a.grossProfit! || tie(a, b)).slice(0, size),
    topMargin: [...ranked].sort((a, b) => b.margin! - a.margin! || tie(a, b)).slice(0, size),
    topSales: [...salesRanked].sort(tie).slice(0, size),
    matches: search ? [...all].sort(tie).slice(0, size) : [],
    pending: pending.sort((a, b) => b.sales - a.sales || tie(a, b)).slice(0, size),
    warnings: ["Utilidad bruta: ventas netas sin IVA menos costos documentados. No es utilidad final ni caja; no distribuye gastos generales.",
      "Ventas y notas de credito por fecha de emision, con costos y reversas vinculados registrados hasta el cierre del periodo. Puede diferir del resultado contable por fechas de contabilizacion o costos sin cliente.",
      ...(pending.length ? [`${pending.length} clientes fuera de los rankings de utilidad/margen por costos, reversas o identidad pendientes. El ranking de ventas conserva clientes identificados con costos pendientes, sin inventar su margen.`] : []),
      ...(excludedDocuments ? [`${excludedDocuments} documentos excluidos por validacion, tipo o importes incompletos.`] : [])],
  };
}
