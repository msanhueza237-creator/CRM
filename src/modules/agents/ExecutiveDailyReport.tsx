import type { ReactNode } from "react";
import { ArrowUpRight, Clock3, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
type Item = { title?: string; detail?: string; href?: string };
export type DailyBrief = { headline?: string; generated_at?: string; report_date?: string; omitted_priorities?: number; sections?: { key: string; title: string; items?: Item[] }[] };
export function ExecutiveDailyReport({ brief, stale, children }: { brief: DailyBrief; stale: boolean; children: ReactNode }) {
  return <section className="data-card agent-module-report executive-daily-report">
    <header><span className="eyebrow">INFORME GERENCIAL / CLIMACTIVA</span><span><Clock3 size={15} />12:00 · Chile</span></header>
    <h2>{brief.headline || "Informe diario"}</h2><p className="executive-daily-date">{brief.generated_at ? new Intl.DateTimeFormat("es-CL", { dateStyle:"long",timeStyle:"short",timeZone:"America/Santiago" }).format(new Date(brief.generated_at)) : "Fecha no disponible"}</p>
    {stale && <p className="notice-banner warning">Ultimo informe completado; hay una solicitud mas reciente.</p>}
    {(brief.sections || []).map((section) => <section key={section.key} className={`executive-daily-section ${section.key}`}><h3>{section.title}</h3>{(section.items || []).map((item,index) => <article key={index}><strong>{section.key === "priorities" && <span>{index+1}</span>}{item.title}</strong><p>{item.detail}</p>{item.href?.startsWith("/") && !item.href.startsWith("//") && <Link to={item.href}>Revisar en modulo <ArrowUpRight size={16} /></Link>}</article>)}</section>)}
    {Boolean(brief.omitted_priorities) && <p>{brief.omitted_priorities} asuntos adicionales en el respaldo completo.</p>}
    <p className="executive-daily-foot"><ShieldCheck size={17} />Sin aprobaciones ni cambios contables automaticos.</p>
    <details className="executive-daily-evidence"><summary>Respaldo completo de los modulos</summary>{children}</details>
  </section>;
}
