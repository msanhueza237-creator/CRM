import { customerTaxId, hasCustomerTaxId } from "../_shared/invoice-customers.ts";
import { identifiedCompany } from "./company-evidence.ts";
import { CopilotDataError, matches, numeric, object, observedAt, readResult, type Row } from "./contracts.ts";
import { dateRange, inRange, localDate } from "./dates.ts";
import { canReadDomain } from "./permissions.ts";
import type { CopilotSources } from "./sources.ts";

type Section = "orders" | "documents" | "quotes" | "activity";
type SourceState = { state: "available" | "unavailable" | "forbidden" | "needs_review"; count: number | null; observedAt: string | null; note: string };
export type JourneyEvent = {
  id: string; section: Section; source: string; date: string | null; title: string;
  detail: string; status: string; amount: number | null; currency: string | null;
  amountBasis: string | null; identity: string | null; href: string | null; observedAt: string | null;
};
const email = (value: unknown) => String(value || "").trim().toLowerCase();
const text = (value: unknown) => String(value ?? "").slice(0, 1500);
export function safeReference(value: unknown): string | null {
  try {
    const url = new URL(String(value || ""));
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// No fuzzy names or phone matches. An explicit different RUT vetoes email matching.
export function orderIdentity(order: Row, company: Row, companies: Row[]): string | null {
  const customer = object(order.customer), billing = object(order.billing_address);
  const taxValues = [customer.identification, customer.tax_id, customer.document, customer.rut,
    billing.identification, billing.tax_id, billing.document, billing.rut].filter(v => v !== null && v !== undefined && v !== "");
  const tax = customerTaxId(company.rut);
  if (taxValues.length) {
    const keys = [...new Set(taxValues.map(customerTaxId))];
    return keys.length === 1 && hasCustomerTaxId(tax) && keys[0] === tax
      && companies.filter(c => customerTaxId(c.rut) === tax).length === 1 ? "RUT exacto" : null;
  }
  const ownEmail = email(company.email);
  const orderEmails = [customer.email, order.contact_email].map(email).filter(Boolean);
  return ownEmail.includes("@") && orderEmails.length > 0 && orderEmails.every(e => e === ownEmail)
    && companies.filter(c => email(c.email) === ownEmail).length === 1 ? "Correo unico de la ficha; sin RUT en pedido" : null;
}

export function orderEvent(record: Row, identity: string): JourneyEvent {
  const order = object(record.payload);
  const currency = /^[A-Z]{3}$/.test(String(order.currency || "")) ? String(order.currency) : null;
  return { id: `order:${record.external_id}`, section: "orders", source: "Tiendanube",
    date: localDate(order.created_at), title: `Pedido ${text(order.number || record.external_id)}`,
    detail: `Pago: ${text(order.payment_status || "sin dato")} · Envio: ${text(order.shipping_status || "sin dato")}`,
    status: text(order.status || "sin dato"), amount: numeric(order.total), currency,
    amountBasis: "Total del pedido informado por Tiendanube", identity, href: null,
    observedAt: text(record.updated_at) || null };
}

export async function customerJourneyTool(source: CopilotSources, args: Row) {
  const company = await identifiedCompany(source, args.company_id), id = String(company.id);
  const range = dateRange({ ...args, period: args.period || "all" });
  const events: JourneyEvent[] = [], sources: Record<string, SourceState> = {};
  let missingDates = false;
  const warnings = [
    "Pedidos y facturas se muestran por separado: pueden representar la misma venta y no se suman. Ningun estado de pedido acredita una conciliacion bancaria.",
    "Las cotizaciones son referencias manuales del CRM, no cotizaciones sincronizadas ni emitidas por Facto. No se infiere su conversion a venta.",
    "El WhatsApp de Tiendanube no se modifica ni se importa su historial de conversaciones. Una interaccion registrada no acredita consentimiento comercial ni entrega del mensaje.",
  ];
  const read = async (key: string, note: string, load: () => Promise<{ events: JourneyEvent[]; stamp: string | null }>) => {
    try {
      const result = await load();
      const filtered = result.events.filter(e => inRange(e.date, range));
      events.push(...filtered);
      sources[key] = { state: "available", count: filtered.length, observedAt: result.stamp, note };
      if (result.events.some(e => !e.date)) { missingDates = true; warnings.push(`${key}: hay registros sin fecha utilizable, fuera del listado por periodo.`); }
    } catch (error) {
      if (source.signal?.aborted) throw error;
      sources[key] = { state: error instanceof CopilotDataError && error.code === "INVALID_ARGUMENTS" ? "needs_review" : "unavailable",
        count: null, observedAt: null, note: error instanceof CopilotDataError ? error.message : "Fuente no disponible. No equivale a ausencia de registros." };
    }
  };
  let pendingTasks: Row[] = [], tasksAvailable = false;
  await read("activity", "Interacciones registradas en el CRM; no es el historial completo de WhatsApp.", async () => {
    const interactions = await source.all(`interactions?select=id,type,description,result,next_action,related_url,occurred_at,updated_at&company_id=eq.${id}&order=id.asc`, 5000);
    return { stamp: observedAt(interactions), events: interactions.map(row => ({
      id: `interaction:${row.id}`, section: String(row.type).toLowerCase() === "cotizacion" ? "quotes" : "activity",
      source: "CRM", date: localDate(row.occurred_at), title: text(row.description),
      detail: [row.result, row.next_action].filter(Boolean).map(text).join(" · "),
      status: String(row.type).toLowerCase() === "cotizacion" ? "Referencia manual" : text(row.type),
      amount: null, currency: null, amountBasis: null, identity: "Ficha CRM", href: safeReference(row.related_url), observedAt: text(row.updated_at) || null,
    })) };
  });
  sources.quotes = { ...sources.activity, count: sources.activity.state === "available" ? events.filter(e => e.section === "quotes").length : null,
    note: "Cotizaciones registradas manualmente en CRM. Sin sincronizacion de cotizaciones Facto." };
  if (sources.activity.count !== null) sources.activity.count = events.filter(e => e.section === "activity").length;
  try {
    pendingTasks = await source.all(`tasks?select=id,title,due_date&company_id=eq.${id}&completed_at=is.null&order=due_date.asc.nullslast,id.asc`, 5000);
    tasksAvailable = true;
  } catch { if (source.signal?.aborted) throw new DOMException("Consulta interrumpida", "AbortError"); warnings.push("No se pudieron consultar las tareas pendientes."); }

  if (canReadDomain(source.actor.role, "sales")) {
    let companies: Row[] | null = null;
    const identities = async () => companies ??= await source.all("companies?select=id,rut,email&order=id.asc");
    await read("documents", "Documentos Facto disponibles en CRM, identificados por RUT. Importes netos sin IVA; no son cobros.", async () => {
      const tax = customerTaxId(company.rut);
      if (!hasCustomerTaxId(tax) || (await identities()).filter(c => customerTaxId(c.rut) === tax).length !== 1)
        throw new CopilotDataError("RUT ausente o duplicado. No se atribuyen documentos por nombre.", "INVALID_ARGUMENTS");
      const entity = await source.entity();
      const docs = await source.all(`accounting_source_documents?select=id,entity_id,source_type,document_type,folio,counterpart_tax_id,issued_on,net_amount,currency,status,data_quality,updated_at&entity_id=eq.${entity}&source_type=eq.FACTO&document_type=like.sales_*&issued_on=gte.${range.from}&issued_on=lte.${range.to}&order=id.asc`, 50000);
      const types: Record<string, string> = { sales_invoice: "Factura", sales_exempt_invoice: "Factura exenta", sales_credit_note: "Nota de credito", sales_debit_note: "Nota de debito" };
      const selected = docs.filter(d => d.entity_id === entity && d.source_type === "FACTO" && types[String(d.document_type)] && customerTaxId(d.counterpart_tax_id) === tax);
      return { stamp: observedAt(selected), events: selected.map(d => ({
        id: `document:${d.id}`, section: "documents", source: "Facto", date: localDate(d.issued_on),
        title: `${types[String(d.document_type)]} ${text(d.folio)}`, detail: `Calidad documental: ${text(d.data_quality)}`,
        status: text(d.status), amount: numeric(d.net_amount), currency: text(d.currency) || null,
        amountBasis: d.document_type === "sales_credit_note" ? "Neto de nota de credito; no es venta positiva" : "Neto sin IVA",
        identity: "RUT exacto", href: `/finanzas-contabilidad?view=facto&document=${encodeURIComponent(String(d.id))}`, observedAt: text(d.updated_at) || null,
      })) };
    });
    await read("orders", "Pedidos sincronizados; no son ventas adicionales a las facturas. Sin coincidencia no acredita ausencia de compras.", async () => {
      const identitiesList = await identities();
      const orders = await source.records("orders", "tiendanube");
      const selected = orders.flatMap(record => {
        const match = orderIdentity(object(record.payload), company, identitiesList);
        return match ? [orderEvent(record, match)] : [];
      });
      return { stamp: observedAt(orders), events: selected };
    });
  } else {
    for (const key of ["documents", "orders"]) sources[key] = { state: "forbidden", count: null, observedAt: null, note: "Tu perfil no tiene acceso a documentos e importes de venta." };
  }
  const filtered = events.filter(e => (!args.section || args.section === "all" || e.section === args.section) && matches(args.query, e.title, e.detail, e.status))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.id.localeCompare(b.id));
  const offset = Number(args.offset || 0), limit = Math.min(Number(args.limit || 20), 25), page = filtered.slice(offset, offset + limit);
  const incomplete = Object.values(sources).some(s => ["unavailable", "needs_review"].includes(s.state)) || !tasksAvailable || missingDates;
  return readResult("get_customer_journey", "customers", `Historial comercial de ${company.name}`, {
    company: { id, name: company.name, rut: company.rut }, period: range, sources, events: page,
    pendingTasks: pendingTasks.slice(0, 20), pendingTaskCount: tasksAvailable ? pendingTasks.length : null,
    nextFollowUp: company.next_follow_up || null, ownerAgent: "commercial",
  }, [{ label: "Ficha comercial", path: `/empresas/${id}#seguimiento`, entityType: "company" }], {
    status: incomplete ? "partial" : filtered.length ? "ok" : "empty", warnings,
    coverage: { complete: !incomplete, totalMatched: filtered.length, returned: page.length, ...range,
      ...(offset + page.length < filtered.length ? { nextOffset: offset + page.length } : {}) },
  });
}
