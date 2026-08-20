import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Instagram,
  PackageSearch,
  Send,
  Settings,
  Sparkles,
} from "lucide-react";
import type { ContentCenterData } from "./useContentCenter";

interface Props {
  data: ContentCenterData;
  onNavigate: (view: string) => void;
}

export function ContentOverview({ data, onNavigate }: Props) {
  const summary = data.bootstrap?.summary;
  const tiendanube = data.bootstrap?.connections.find((item) => item.provider === "tiendanube");
  const meta = data.bootstrap?.connections.find((item) => item.provider === "meta_social");
  const defaultBrand = data.bootstrap?.brands.find((item) => item.is_default);
  const nextPublication = data.publications
    .filter((item) => item.status === "scheduled" && item.scheduled_at)
    .sort((left, right) => String(left.scheduled_at).localeCompare(String(right.scheduled_at)))[0];

  return (
    <div className="content-view-stack">
      <section className="content-command-band">
        <div>
          <span className="eyebrow">Motor de marketing</span>
          <h2>Contenido coordinado con productos reales</h2>
          <p>Tiendanube aporta los hechos; la IA prepara borradores, el calendario ordena el trabajo y los conectores publican solo cuando corresponde.</p>
        </div>
        <button className="primary-button" type="button" onClick={() => onNavigate("generator")}>
          <Sparkles size={18} /> Crear contenido
        </button>
      </section>

      <section className="content-connection-strip" aria-label="Estado de conexiones">
        <ConnectionState
          connected={tiendanube?.status === "connected"}
          icon={<PackageSearch size={20} />}
          title="Catálogo Tiendanube"
          detail={tiendanube?.status === "connected" ? `${summary?.products ?? 0} productos disponibles` : tiendanube?.message || "Conexión pendiente"}
        />
        <ConnectionState
          connected={meta?.status === "connected"}
          icon={<Instagram size={20} />}
          title="Instagram y Facebook"
          detail={meta?.status === "connected" ? "Meta Social conectado" : meta?.message || "Integración faltante"}
        />
        {meta?.status !== "connected" || tiendanube?.status !== "connected" ? (
          <Link className="ghost-button" to="/administracion">
            <Settings size={17} /> Ir a Integraciones
          </Link>
        ) : null}
      </section>

      {!defaultBrand?.configured ? (
        <section className="content-setup-band">
          <div><Sparkles size={22} /><div><strong>Completa la personalidad de marca</strong><span>Define tono, palabras, llamados a la acción y reglas que usará toda generación.</span></div></div>
          <button className="ghost-button" type="button" onClick={() => onNavigate("brand")}>Configurar marca <ArrowRight size={17} /></button>
        </section>
      ) : null}

      <section className="content-kpi-grid">
        <Kpi icon={<PackageSearch />} label="Biblioteca" value={summary?.products ?? data.products.length} detail={`${summary?.productsIncomplete ?? 0} requieren información`} />
        <Kpi icon={<CalendarClock />} label="Programadas" value={summary?.scheduledThisWeek ?? 0} detail="Próximos 7 días" />
        <Kpi icon={<Send />} label="Publicadas" value={summary?.publishedThisWeek ?? 0} detail="Esta semana" />
        <Kpi icon={<Clock3 />} label="Por aprobar" value={summary?.pendingApproval ?? 0} detail="Revisión humana" />
        <Kpi icon={<AlertTriangle />} label="Errores" value={summary?.failed ?? 0} detail="Requieren atención" tone={(summary?.failed ?? 0) > 0 ? "danger" : "normal"} />
      </section>

      <section className="content-overview-grid">
        <div className="panel">
          <div className="panel-heading"><div><h2>Próxima publicación</h2><span>Orden operativo actual</span></div></div>
          {nextPublication ? (
            <div className="content-next-publication">
              <CalendarClock size={28} />
              <div>
                <strong>{productName(data, nextPublication.product_id)}</strong>
                <span>{channelName(data, nextPublication.channel_id)} · {formatDateTime(nextPublication.scheduled_at)}</span>
                <p>{nextPublication.body}</p>
              </div>
            </div>
          ) : (
            <div className="empty-state"><CalendarClock size={28} /><strong>Sin publicaciones programadas</strong><span>Genera un borrador, apruébalo y elige su fecha.</span></div>
          )}
          <button className="panel-link" type="button" onClick={() => onNavigate("calendar")}>Abrir calendario <ArrowRight size={16} /></button>
        </div>

        <div className="panel">
          <div className="panel-heading"><div><h2>Actividad reciente</h2><span>Trazabilidad del módulo</span></div></div>
          <div className="content-activity-list">
            {data.history.slice(0, 6).map((event) => (
              <div key={event.id}>
                {event.level === "error" ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
                <div><strong>{event.message}</strong><span>{formatDateTime(event.created_at)}</span></div>
              </div>
            ))}
            {!data.history.length ? <div className="empty-state"><Clock3 size={26} /><span>La actividad aparecerá con la primera sincronización o generación.</span></div> : null}
          </div>
          <button className="panel-link" type="button" onClick={() => onNavigate("history")}>Ver historial completo <ArrowRight size={16} /></button>
        </div>
      </section>
    </div>
  );
}

function ConnectionState({ connected, icon, title, detail }: { connected: boolean; icon: React.ReactNode; title: string; detail: string }) {
  return <div className={connected ? "connected" : "attention"}>{icon}<div><strong>{title}</strong><span>{detail}</span></div>{connected ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}</div>;
}

function Kpi({ icon, label, value, detail, tone = "normal" }: { icon: React.ReactNode; label: string; value: number; detail: string; tone?: "normal" | "danger" }) {
  return <article className={tone === "danger" ? "danger" : ""}>{icon}<span>{label}</span><strong>{value.toLocaleString("es-CL")}</strong><small>{detail}</small></article>;
}

function productName(data: ContentCenterData, id: string | null) {
  return data.products.find((item) => item.id === id)?.name || "Contenido sin producto";
}

function channelName(data: ContentCenterData, id: string) {
  return data.bootstrap?.channels.find((item) => item.id === id)?.name || "Canal social";
}

function formatDateTime(value: string | null) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
