import {
  dashboardDocumentSales,
  dashboardSalesEvidence,
  dashboardSalesPeriodBridge,
} from "../accounting-center/dashboard-sales.ts";
import { confirmedCostSourceIds } from "../accounting-center/facto-cost-evidence.ts";
import { creditNoteCostReview, creditNoteCostPeriod, creditNoteReferences } from "../accounting-center/credit-note-costs.ts";
import {
  CopilotDataError,
  decimalSum,
  matches,
  numeric,
  object,
  observedAt,
  tableResult,
  type Row,
  type ReadResult,
} from "./contracts.ts";
import { dateRange, todayChile } from "./dates.ts";
import { CopilotSources } from "./sources.ts";

export type Period = { from: string; to: string };
const sum = (values: unknown[]) => Number(decimalSum(values) ?? NaN);
const money = (n: number) => Number(n.toFixed(4));
const rut = (value: unknown) =>
  String(value || "")
    .replace(/[^0-9kK]/g, "")
    .toUpperCase();
const flagPaths = [
  "",
  "data->",
  "document->",
  "data->document->",
  "data->header->",
  "document->header->",
  "data->document->header->",
  "header->",
  "data->totals->",
  "document->totals->",
  "data->document->totals->",
  "totals->",
];
const docFields =
  "id,entity_id,external_id,source_type,document_type,folio,counterpart_tax_id,counterpart_name,issued_on,currency,exchange_rate,net_amount,exempt_amount,tax_amount,total_clp,status,data_quality,updated_at,credit_references:raw_payload->references," +
  flagPaths
    .map((path, i) => `direction_${i}:raw_payload->${path}received_issued_flag`)
    .join(",");
const ledgerFields =
  "id,account_id,debit_clp,credit_clp,accounting_journal_entries!inner(id,entry_date,source_document_id,status)";

export function projectedSalesDocument(row: Row): Row {
  const flags = flagPaths.map((_, i) => row[`direction_${i}`]);
  // A contradictory received-document flag must never become a sale after projection.
  const received = flags.some((flag) => flag === 0 || flag === "0");
  return {
    ...row,
    raw_payload: { ...object(row.raw_payload), ...(Array.isArray(row.credit_references) ? { references: row.credit_references } : {}),
      ...(received ? { received_issued_flag: 0 } : {}) },
  };
}

export async function salesDocuments(source: CopilotSources, range: Period) {
  const entity = await source.entity();
  return (
    await source.all(
      `accounting_source_documents?select=${docFields}&entity_id=eq.${entity}&source_type=eq.FACTO&document_type=like.sales_*&issued_on=gte.${range.from}&issued_on=lte.${range.to}&order=id.asc`,
      10000,
    )
  ).map(projectedSalesDocument);
}

export function aggregateFinancialPeriod(
  documents: Row[],
  periodLines: Row[],
  linkedLines: Row[],
  accounts: Row[],
  range: Period,
  asOf = range.to,
) {
  const accountMap = new Map(accounts.map((a) => [String(a.id), a]));
  const incomeIds = new Set(
    accounts
      .filter((a) => a.account_type === "income")
      .map((a) => String(a.id)),
  );
  const evidence = dashboardSalesEvidence(
    documents,
    linkedLines,
    incomeIds,
    asOf,
  );
  const missing = evidence.filter(
    (d) => !d.posted && d.issuedOn >= range.from && d.issuedOn <= range.to,
  );
  const amounts = (type: string, credit = false) =>
    periodLines
      .filter(
        (l) => accountMap.get(String(l.account_id))?.account_type === type,
      )
      .map((l) =>
        money(
          (numeric(credit ? l.credit_clp : l.debit_clp) ?? NaN) -
            (numeric(credit ? l.debit_clp : l.credit_clp) ?? NaN),
        ),
      );
  const ledgerSales = sum(amounts("income", true));
  const pendingSales = sum(missing.map((d) => d.netClp));
  const sales = money(ledgerSales + pendingSales),
    costs = sum(amounts("cost")),
    expenses = sum(amounts("expense")),
    otherResults = sum(amounts("result", true));
  if (![sales, costs, expenses, otherResults].every(Number.isFinite))
    throw new CopilotDataError(
      "Hay importes contables incompletos; no se calculan como cero.",
    );
  const coverage = confirmedCostSourceIds(linkedLines, accounts, asOf);
  const bridge = dashboardSalesPeriodBridge(
    evidence,
    range.from,
    range.to,
    sales,
    coverage,
  );
  const grossProfit = money(sales - costs);
  const creditCosts = creditNoteCostPeriod(creditNoteCostReview(documents, linkedLines, accounts, asOf), range.from, range.to);
  return {
    ...range,
    sales,
    salesLedger: ledgerSales,
    salesPending: pendingSales,
    salesPendingDocuments: missing.length,
    costs,
    expenses,
    otherResults,
    grossProfit,
    operatingProfit: money(grossProfit - expenses + otherResults),
    grossMargin: sales > 0 ? (grossProfit / sales) * 100 : null,
    ...bridge,
    ...creditCosts,
    excludedDocuments: documents.filter(
      (d) =>
        String(d.issued_on) >= range.from &&
        String(d.issued_on) <= range.to &&
        dashboardDocumentSales(d) === null,
    ).length,
  };
}

export async function financialPeriod(
  source: CopilotSources,
  args: Row,
): Promise<ReadResult> {
  const range = dateRange(args);
  if (range.to > todayChile()) range.to = todayChile();
  if (
    range.from > range.to ||
    Date.parse(range.to) - Date.parse(range.from) > 732 * 86400000
  )
    throw new CopilotDataError(
      "Consulta hasta dos anos a la vez, sin fechas futuras.",
      "INVALID_ARGUMENTS",
    );
  const entity = await source.entity();
  const docs = await salesDocuments(source, range);
  const accounts = await source.all(
    `accounting_accounts?select=id,account_type,classification&entity_id=eq.${entity}&order=id.asc`,
  );
  const asOf = todayChile();
  const scope = `&accounting_journal_entries.entity_id=eq.${entity}&accounting_journal_entries.status=in.(posted,reversed)`;
  const lines = await source.all(
    `accounting_journal_lines?select=${ledgerFields}${scope}&accounting_journal_entries.entry_date=gte.${range.from}&accounting_journal_entries.entry_date=lte.${range.to}&order=id.asc`,
    20000,
  );
  const issuedIds = new Set(docs.map((d) => String(d.id)));
  const extraIds = [
    ...new Set(
      lines
        .map((l) =>
          String(object(l.accounting_journal_entries).source_document_id || ""),
        )
        .filter((id) => id && !issuedIds.has(id)),
    ),
  ];
  for (let i = 0; i < extraIds.length; i += 100) {
    const ids = extraIds.slice(i, i + 100);
    if (!ids.every((id) => /^[a-f0-9-]{36}$/i.test(id)))
      throw new CopilotDataError("Identidad documental invalida.");
    docs.push(
      ...(
        await source.all(
          `accounting_source_documents?select=${docFields}&entity_id=eq.${entity}&source_type=eq.FACTO&document_type=like.sales_*&id=in.(${ids.join(",")})&order=id.asc`,
          100,
        )
      ).map(projectedSalesDocument),
    );
  }
  // Resolve only explicitly referenced invoices, including those issued in a prior month.
  const referencedIds = [...new Set(docs.filter(d => d.document_type === "sales_credit_note")
    .flatMap(d => creditNoteReferences(d).map(r => String(r.document_id || ""))).filter(id => /^\d+$/.test(id)))];
  const knownExternalIds = new Set(docs.map(d => String(d.external_id)));
  const missingReferences = referencedIds.filter(id => !knownExternalIds.has(id));
  for (let i = 0; i < missingReferences.length; i += 100) {
    docs.push(...(await source.all(`accounting_source_documents?select=${docFields}&entity_id=eq.${entity}&source_type=eq.FACTO&document_type=like.sales_*&external_id=in.(${missingReferences.slice(i, i + 100).join(",")})&order=id.asc`, 100)).map(projectedSalesDocument));
  }
  // Include earlier postings of issued documents so a prior posting cannot be added again.
  const linked: Row[] = [];
  for (let i = 0; i < docs.length; i += 100) {
    const ids = docs.slice(i, i + 100).map((d) => String(d.id));
    if (!ids.every((id) => /^[a-f0-9-]{36}$/i.test(id)))
      throw new CopilotDataError("Identidad documental invalida.");
    linked.push(
      ...(await source.all(
        `accounting_journal_lines?select=${ledgerFields}${scope}&accounting_journal_entries.entry_date=lte.${asOf}&accounting_journal_entries.source_document_id=in.(${ids.join(",")})&order=id.asc`,
        10000,
      )),
    );
  }
  const totals = aggregateFinancialPeriod(
    docs,
    lines,
    linked,
    accounts,
    range,
    asOf,
  );
  const months: Row[] = [];
  const date = new Date(`${range.from.slice(0, 7)}-01T12:00:00Z`);
  while (date.toISOString().slice(0, 10) <= range.to) {
    const key = date.toISOString().slice(0, 7);
    const from = key + "-01" > range.from ? key + "-01" : range.from;
    const end = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
    )
      .toISOString()
      .slice(0, 10);
    const to = end < range.to ? end : range.to;
    const relevantLines = lines.filter(
      (l) =>
        String(object(l.accounting_journal_entries).entry_date) >= from &&
        String(object(l.accounting_journal_entries).entry_date) <= to,
    );
    months.push({
      period: key,
      ...aggregateFinancialPeriod(
        docs,
        relevantLines,
        linked,
        accounts,
        { from, to },
        asOf,
      ),
    });
    date.setUTCMonth(date.getUTCMonth() + 1);
  }
  const warnings = [
    "Resultado provisional con los costos y asientos registrados. No es caja ni cierre contable.",
    "Ventas en resultado incluyen regularizaciones en su fecha contable. Ventas emitidas usan la fecha del documento; no se suman entre si.",
  ];
  if (totals.salesPendingDocuments)
    warnings.push(
      `${totals.salesPendingDocuments} documentos tienen asiento de ingreso pendiente en CRM. Ya incluidos una sola vez en ventas.`,
    );
  if (totals.salesCostMissingDocuments)
    warnings.push(
      `${totals.salesCostMissingDocuments} documentos tienen costo pendiente en CRM; la utilidad puede estar sobreestimada.`,
    );
  if (totals.creditNoteCostPending)
    warnings.push(`${totals.creditNoteCostPending} notas de credito tienen costo/reversa por verificar. No afirmar que todos los costos estan completos. El resultado ya descuenta las reversas contabilizadas; no restar el importe de venta ni el costo de otra factura.`);
  if (totals.salesCreditPriorInvoiceDocuments)
    warnings.push(`${totals.salesCreditPriorInvoiceDocuments} notas incluidas en ventas netas corresponden a facturas emitidas antes del periodo: ${totals.salesCreditPriorInvoices} CLP netos. Explicar este efecto temporal; no cambiar fechas ni excluir el costo de facturas vigentes.`);
  if (totals.excludedDocuments)
    warnings.push(
      `${totals.excludedDocuments} documentos no son contabilizables o tienen importes pendientes y se excluyeron.`,
    );
  const path = `/finanzas-contabilidad?view=detail&metric=operating-profit&from=${range.from}&to=${range.to}`;
  const result = tableResult(
    "get_sales_summary",
    "finance",
    "Ventas y resultado por mes (CLP)",
    months,
    [
      { key: "period", label: "Mes" },
      { key: "sales", label: "Ventas netas CLP" },
      { key: "costs", label: "Costo CLP" },
      { key: "expenses", label: "Gastos CLP" },
      { key: "operatingProfit", label: "Resultado CLP" },
    ],
    path,
    { limit: 24 },
    warnings,
  );
  result.data = {
    period: range,
    totals,
    monthly: months,
    basis: "ledger_plus_unposted_validated_documents",
    currency: "CLP",
    provisional: true,
    creditNoteCosts: creditNoteCostReview(docs, linked, accounts, asOf).filter(r => r.recognizedOn >= range.from && r.recognizedOn <= range.to),
  };
  result.status = "partial";
  result.coverage = { ...result.coverage, ...range };
  result.freshness.sourceObservedAt = observedAt(docs);
  result.components = [
    {
      type: "kpi",
      title: "Ventas netas",
      value: totals.sales,
      unit: "CLP",
      classification: "calculation",
    },
    {
      type: "kpi",
      title: "Margen bruto provisional",
      value: totals.grossMargin,
      unit: "percent",
      classification: "calculation",
    },
    {
      type: "kpi",
      title: "Resultado operativo provisional",
      value: totals.operatingProfit,
      unit: "CLP",
      classification: "calculation",
    },
    {
      type: "chart",
      chartType: args.chart === "bar" ? "bar" : "line",
      title: "Ventas y resultado por mes",
      labels: months.map((m) => String(m.period)),
      series: [
        { name: "Ventas netas", values: months.map((m) => Number(m.sales)) },
        {
          name: "Resultado operativo",
          values: months.map((m) => Number(m.operatingProfit)),
        },
      ],
      unit: "CLP",
      classification: "calculation",
    },
  ];
  return result;
}

export async function comparePeriods(
  source: CopilotSources,
  args: Row,
): Promise<ReadResult> {
  const current = await financialPeriod(source, args);
  const previous = await financialPeriod(source, {
    period: args.compare_period || "last_month",
    from: args.compare_from,
    to: args.compare_to,
  });
  const a = object(object(current.data).totals),
    b = object(object(previous.data).totals);
  const metrics = [
    ["sales", "Ventas netas"],
    ["costs", "Costo de ventas"],
    ["expenses", "Gastos"],
    ["grossProfit", "Utilidad bruta"],
    ["operatingProfit", "Resultado operativo"],
  ];
  const records = metrics.map(([key, label]) => ({
    metric: label,
    current: a[key],
    previous: b[key],
    change: money(Number(a[key]) - Number(b[key])),
    change_percent: Number(b[key])
      ? ((Number(a[key]) - Number(b[key])) / Math.abs(Number(b[key]))) * 100
      : null,
  }));
  const result = tableResult(
    "compare_sales_periods",
    "finance",
    "Comparacion de periodos",
    records,
    [
      { key: "metric", label: "Indicador CLP" },
      { key: "current", label: "Periodo consultado" },
      { key: "previous", label: "Comparacion" },
      { key: "change_percent", label: "Variacion %" },
    ],
    "/dashboard",
    {},
    [
      ...current.warnings,
      ...previous.warnings,
      "La comparacion conserva los periodos completos solicitados; un mes en curso puede estar incompleto.",
    ],
  );
  result.data = { current: current.data, previous: previous.data, records };
  result.status = "partial";
  result.components = [
    {
      type: "chart",
      chartType: "bar",
      title: "Comparacion financiera",
      labels: records.map((r) => r.metric),
      series: [
        {
          name: `${a.from} a ${a.to}`,
          values: records.map((r) => Number(r.current)),
        },
        {
          name: `${b.from} a ${b.to}`,
          values: records.map((r) => Number(r.previous)),
        },
      ],
      unit: "CLP",
      classification: "calculation",
    },
  ];
  return result;
}

export async function customerAnalytics(
  source: CopilotSources,
  args: Row,
): Promise<ReadResult> {
  const range = dateRange({ ...args, period: args.period || "this_year" });
  const documents = await salesDocuments(source, range);
  const companies = await source.all(
    "companies?select=id,name,rut,type,city,region,priority&order=id.asc",
  );
  const groups = new Map<string, Row>();
  let omitted = 0;
  for (const doc of documents) {
    const amount = dashboardDocumentSales(doc);
    if (amount === null) {
      omitted++;
      continue;
    }
    const tax = rut(doc.counterpart_tax_id),
      key = tax || `unidentified:${doc.id}`;
    const companyMatches = tax
      ? companies.filter((c) => rut(c.rut) === tax)
      : [];
    const company = companyMatches.length === 1 ? companyMatches[0] : {};
    const group = groups.get(key) || {
      id: company.id || key,
      name: company.name || doc.counterpart_name || "Identidad pendiente",
      rut: doc.counterpart_tax_id,
      category: company.type || null,
      city: company.city || null,
      region: company.region || null,
      net_sales: 0,
      invoices: 0,
      credit_notes: 0,
      last_purchase: null,
      months: {},
    };
    group.net_sales = money(Number(group.net_sales) + amount);
    const month = String(doc.issued_on).slice(0, 7),
      monthly = object(group.months);
    monthly[month] = money(Number(monthly[month] || 0) + amount);
    group.months = monthly;
    if (doc.document_type === "sales_credit_note")
      group.credit_notes = Number(group.credit_notes) + 1;
    else {
      group.invoices = Number(group.invoices) + 1;
      if (String(doc.issued_on) > String(group.last_purchase || ""))
        group.last_purchase = doc.issued_on;
    }
    groups.set(key, group);
  }
  const records = [...groups.values()]
    .map<Row & { inactive_days: number | null }>((g) => ({
      ...g,
      inactive_days: g.last_purchase
        ? Math.floor(
            (Date.parse(todayChile()) - Date.parse(String(g.last_purchase))) /
              86400000,
          )
        : null,
      average_invoice: Number(g.invoices)
        ? Number(g.net_sales) / Number(g.invoices)
        : null,
    }))
    .filter((g) => matches(args.query, g.name, g.rut))
    .filter((g) => !args.category || matches(args.category, g.category))
    .filter(
      (g) =>
        !args.inactive_days ||
        (g.inactive_days !== null &&
          g.inactive_days >= Number(args.inactive_days)),
    )
    .sort((a, b) => Number(b.net_sales) - Number(a.net_sales));
  const result = tableResult(
    "get_customer_sales",
    "sales",
    "Clientes por facturacion neta documental",
    records,
    [
      { key: "name", label: "Cliente" },
      { key: "rut", label: "RUT" },
      { key: "category", label: "Segmento" },
      { key: "net_sales", label: "Neto CLP" },
      { key: "invoices", label: "Documentos" },
      { key: "last_purchase", label: "Ultima compra en periodo" },
      { key: "inactive_days", label: "Dias sin compra" },
    ],
    "/empresas",
    args,
    [
      "Facturacion neta emitida, con notas de credito descontadas. No son cobros ni resultado contable por fecha de regularizacion.",
      "La ultima compra se conoce solo dentro del periodo consultado. No se afirma inactividad de clientes sin fecha documentada.",
      ...(omitted
        ? [
            `${omitted} documentos sin validacion/importes completos fueron excluidos.`,
          ]
        : []),
    ],
  );
  result.data = {
    ...object(result.data),
    period: range,
    total_customers: records.length,
    total_net_clp: sum(records.map((r) => r.net_sales)),
    omitted_documents: omitted,
  };
  result.coverage = { ...result.coverage, ...range };
  if (omitted) result.status = "partial";
  result.freshness.sourceObservedAt = observedAt(documents);
  return result;
}
