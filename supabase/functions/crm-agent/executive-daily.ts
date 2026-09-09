type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(obj) : [];
const num = (v: unknown): number | null => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const money = (v: unknown) => num(v) === null ? "No disponible" : new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(Number(v));

export function executiveDailySlot(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const p = (key: string) => parts.find((part) => part.type === key)!.value;
  const day = `${p("year")}-${p("month")}-${p("day")}`;
  const localAsUtc = Date.parse(`${day}T${p("hour")}:${p("minute")}:${p("second")}Z`);
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return { day, key: `executive:${day}:1200`, due: Number(p("hour")) >= 12 && Number(p("hour")) < 20,
    scheduledFor: new Date(Date.parse(`${day}T12:00:00Z`) - offset).toISOString() };
}

export function buildExecutiveDailyBrief(report: Row, previous: Row | null, consultedAt: string) {
  const m = obj(report.metrics), accounting = obj(report.accounting), period = obj(accounting.period);
  const sections = rows(report.sections);
  const data = (key: string) => rows(sections.find((s) => s.key === key)?.rows);
  const day = executiveDailySlot(new Date(consultedAt)).day;
  const priorities: { title: string; detail: string; href: string; rank: number }[] = [];
  const add = (rank: number, title: string, detail: string, href: string) => priorities.push({ rank, title, detail, href });
  if (m.verified_receivables_available !== true) add(0, "Validar cartera antes de gestionar cobros", "La fuente no confirma una cartera completa. Revisar la carga de Finanzas; no interpretar datos faltantes como deuda cero.", "/finanzas-contabilidad?view=receivables");
  else if (String(accounting.source_as_of || "") < day && accounting.source_as_of) add(2, "Actualizar el respaldo de cobranza", `La cartera conserva el corte ${accounting.source_as_of}. El saldo no es una consulta en vivo.`, "/finanzas-contabilidad?view=receivables");
  if ((num(m.overdue_amount) || 0) > 0) add(1, "Priorizar cartera vencida", `${money(m.overdue_amount)} vencidos segun Finanzas. Revisar documentos y abonos antes de contactar.`, "/finanzas-contabilidad?view=receivables");
  if ((num(m.operating_profit) ?? 0) < 0) add(1, "Revisar resultado operativo negativo", `${money(m.operating_profit)} en ${period.from || "inicio no informado"} a ${period.to || day}; ${accounting.provisional ? "resultado provisional" : "base del modulo"}.`, "/finanzas-contabilidad?view=reports");
  if ((num(m.failed_publications) || 0) > 0) add(2, "Resolver publicaciones con error", `${m.failed_publications} publicaciones fallidas o parciales. Revisar la causa antes de reintentar.`, "/contenido?view=publications");
  const soon = new Date(`${day}T12:00:00Z`); soon.setUTCDate(soon.getUTCDate() + 7);
  const due = data("operations").filter((r) => r.operation_type !== "simulation" && ["in_transit", "customs", "ordered", "in_production"].includes(String(r.status)) && r.estimated_arrival && String(r.estimated_arrival).slice(0, 10) <= soon.toISOString().slice(0, 10));
  if (due.length) add(1, "Supervisar llegadas comprometidas", due.slice(0, 3).map((r) => `${r.reference || r.title}: ${String(r.estimated_arrival).slice(0, 10)}`).join("; "), String(due[0].href || "/comercio-exterior"));
  if ((num(m.pending_approval) || 0) > 0) add(3, "Decidir contenido pendiente", `${m.pending_approval} publicaciones esperan aprobacion.`, "/contenido?view=publications");
  if ((num(m.followups_overdue) || 0) > 0) add(4, "Retomar seguimientos comerciales", `${m.followups_overdue} empresas tienen seguimientos atrasados. Priorizar responsable y proxima accion.`, "/empresas");
  if ((num(m.stock_unknown) || 0) > 0) add(4, "Verificar disponibilidad antes de prometer stock", `${m.stock_unknown} SKU no tienen existencias verificadas; no se consideran stock cero.`, "/contenido?view=library");
  const selected = priorities.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title)).slice(0, 5);
  const briefSections: Row[] = [{ key: "priorities", title: "Decisiones prioritarias", count: selected.length, items: selected.length ? selected : [{ title: "Sin alertas prioritarias detectadas", detail: "En los modulos consultados no se detectaron asuntos que superen los criterios de este informe. No equivale a una auditoria contable completa.", href: "/agentes" }] },
    { key: "finance", title: "Situacion financiera · CLP", count: 3, items: [
      { title: "Liquidez y compromisos", detail: `Bancos ${money(m.bank_clp)}; por cobrar ${money(m.receivables)}; por pagar ${money(m.payables)}; cheques en cartera ${money(m.checks_portfolio)}. Los cheques no son caja disponible.`, href: "/finanzas-contabilidad?view=dashboard" },
      { title: "Resultado del periodo", detail: `${period.from || "Inicio no informado"} a ${period.to || day}: ventas ${money(m.net_sales)}, costo ${money(m.cost_of_sales)}, resultado operativo ${money(m.operating_profit)}${accounting.provisional ? " (provisional)" : ""}.`, href: "/finanzas-contabilidad?view=reports" },
      { title: "Respaldo", detail: `Cartera al ${accounting.source_as_of || "corte no disponible"}; base ${accounting.basis || "no disponible"}. Consulta ${day}.`, href: "/finanzas-contabilidad?view=receivables" },
    ] }];
  const old = obj(previous?.metrics);
  const changes: Row[] = [];
  const comparable = obj(previous?.accounting);
  const samePeriod = obj(comparable.period).from === period.from && comparable.basis === accounting.basis;
  for (const [key, label, href] of [["receivables", "Cartera por cobrar", "/finanzas-contabilidad?view=receivables"], ["net_sales", "Ventas acumuladas", "/finanzas-contabilidad?view=reports"], ["bank_clp", "Saldo bancario", "/finanzas-contabilidad?view=banks"]]) {
    if (key === "net_sales" && !samePeriod) continue;
    const value = num(m[key]), before = num(old[key]);
    if (value !== null && before !== null && Math.abs(value - before) >= 1) changes.push({ title: label, detail: `${money(before)} a ${money(value)}; variacion ${money(value - before)}. No implica por si sola un movimiento de caja.`, href });
  }
  if (changes.length) briefSections.push({ key: "changes", title: "Cambios desde el ultimo informe diario", count: changes.length, items: changes });
  return { generated_at: consultedAt, mode: "daily", report_date: day, overall_status: selected.length ? "attention" : "stable",
    headline: selected.length ? `${selected.length} prioridades para hoy · CLIMACTIVA` : "Corte diario sin alertas prioritarias · CLIMACTIVA",
    sections: briefSections, recommendations: selected.map((r) => `${r.title}. ${r.detail}`), omitted_priorities: Math.max(0, priorities.length - selected.length) };
}
