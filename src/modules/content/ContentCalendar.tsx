import { FormEvent, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, List, Plus, RefreshCw } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthContext";
import type { ContentPublication } from "../../types/content";
import type { ContentCenterData } from "./useContentCenter";

type CalendarMode = "month" | "week" | "list";

export function ContentCalendar({ data }: { data: ContentCenterData }) {
  const { user } = useAuth();
  const canSchedule = data.bootstrap?.profile.permissions.includes("content.schedule") ?? false;
  const [mode, setMode] = useState<CalendarMode>("month");
  const [cursor, setCursor] = useState(startOfDay(new Date()));
  const [channelId, setChannelId] = useState("");
  const [productId, setProductId] = useState("");
  const [status, setStatus] = useState("");
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const entries = useMemo(() => data.publications.filter((item) => {
    if (!item.scheduled_at && !item.published_at) return false;
    if (channelId && item.channel_id !== channelId) return false;
    if (productId && item.product_id !== productId) return false;
    if (status && item.status !== status) return false;
    return true;
  }), [channelId, data.publications, productId, status]);

  const days = mode === "week" ? weekDays(cursor) : monthDays(cursor);
  const title = mode === "month"
    ? new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(cursor)
    : mode === "week"
      ? `Semana del ${formatDate(days[0])}`
      : "Próximas publicaciones";

  function move(direction: number) {
    const next = new Date(cursor);
    if (mode === "month") next.setMonth(next.getMonth() + direction);
    else next.setDate(next.getDate() + direction * 7);
    setCursor(next);
  }

  async function dropOnDay(event: React.DragEvent, day: Date) {
    event.preventDefault();
    if (user?.role !== "administrador" || !supabase) return;
    const publicationId = event.dataTransfer.getData("text/publication-id");
    const publication = data.publications.find((item) => item.id === publicationId);
    if (!publication?.scheduled_at) return;
    const oldDate = new Date(publication.scheduled_at);
    const target = new Date(day);
    target.setHours(oldDate.getHours(), oldDate.getMinutes(), 0, 0);
    const { error: updateError } = await supabase.from("content_publications").update({ scheduled_at: target.toISOString() }).eq("id", publicationId);
    if (updateError) setError(updateError.message);
    else { setNotice(`Publicación reprogramada para ${formatDateTime(target.toISOString())}.`); await data.refresh(); }
  }

  return (
    <div className="content-view-stack">
      <section className="content-calendar-toolbar panel">
        <div className="content-segmented"><button className={mode === "month" ? "active" : ""} type="button" onClick={() => setMode("month")}><CalendarDays size={17} /> Mes</button><button className={mode === "week" ? "active" : ""} type="button" onClick={() => setMode("week")}><CalendarDays size={17} /> Semana</button><button className={mode === "list" ? "active" : ""} type="button" onClick={() => setMode("list")}><List size={17} /> Lista</button></div>
        <div className="content-calendar-navigation">{mode !== "list" ? <><button className="icon-button" type="button" onClick={() => move(-1)} aria-label="Anterior"><ChevronLeft size={18} /></button><strong>{title}</strong><button className="icon-button" type="button" onClick={() => move(1)} aria-label="Siguiente"><ChevronRight size={18} /></button></> : <strong>{title}</strong>}</div>
        {canSchedule ? <button className="primary-button" type="button" onClick={() => setShowScheduleForm((current) => !current)}><Plus size={17} /> Nueva regla</button> : null}
      </section>

      <section className="content-calendar-filters">
        <label><span>Red</span><select value={channelId} onChange={(event) => setChannelId(event.target.value)}><option value="">Todas</option>{data.bootstrap?.channels.map((channel) => <option value={channel.id} key={channel.id}>{channel.name}</option>)}</select></label>
        <label><span>Producto</span><select value={productId} onChange={(event) => setProductId(event.target.value)}><option value="">Todos</option>{data.products.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}</select></label>
        <label><span>Estado</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Todos</option><option value="pending_approval">Pendiente</option><option value="approved">Aprobado</option><option value="scheduled">Programado</option><option value="published">Publicado</option><option value="failed">Error</option></select></label>
      </section>

      {showScheduleForm ? <ScheduleForm data={data} onClose={() => setShowScheduleForm(false)} onSaved={(message) => { setNotice(message); setShowScheduleForm(false); }} onError={setError} /> : null}
      {notice ? <div className="notice-banner success">{notice}</div> : null}
      {error ? <div className="notice-banner error">{error}</div> : null}

      {mode === "list" ? (
        <CalendarList entries={entries} data={data} />
      ) : (
        <section className={`content-calendar-grid ${mode}`}>
          {mode === "month" ? ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((label) => <div className="content-calendar-weekday" key={label}>{label}</div>) : null}
          {days.map((day) => {
            const dayEntries = entries.filter((item) => sameDay(publicationDate(item), day));
            const outside = mode === "month" && day.getMonth() !== cursor.getMonth();
            return <div className={`content-calendar-day ${outside ? "outside" : ""} ${sameDay(day, new Date()) ? "today" : ""}`} key={day.toISOString()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => void dropOnDay(event, day)}><time>{day.getDate()}</time><div>{dayEntries.map((item) => <CalendarEntry key={item.id} publication={item} data={data} draggable={user?.role === "administrador"} />)}</div></div>;
          })}
        </section>
      )}

      <section className="panel content-recurring-rules">
        <div className="panel-heading"><div><h2>Reglas recurrentes</h2><span>El scheduler las procesa sin depender del navegador</span></div><RefreshCw size={20} /></div>
        {data.bootstrap?.schedules.map((schedule) => <div key={schedule.id}><div><strong>{schedule.name}</strong><span>{scheduleLabel(schedule.recurrence_type, schedule.recurrence_rule)} · {schedule.operation_mode === "autopilot" ? "Piloto automático" : "Con aprobación"}</span></div><span className={`content-state ${schedule.active ? "scheduled" : "paused"}`}>{schedule.active ? "Activa" : "Pausada"}</span><time>{schedule.next_run_at ? `Próxima: ${formatDateTime(schedule.next_run_at)}` : "Sin próxima fecha"}</time></div>)}
        {!data.bootstrap?.schedules.length ? <div className="empty-state"><Clock3 size={26} /><span>No hay reglas recurrentes configuradas.</span></div> : null}
      </section>
    </div>
  );
}

function ScheduleForm({ data, onClose, onSaved, onError }: { data: ContentCenterData; onClose: () => void; onSaved: (message: string) => void; onError: (message: string) => void }) {
  const { user } = useAuth();
  const [name, setName] = useState("Plan editorial");
  const [channelIds, setChannelIds] = useState<string[]>(data.bootstrap?.channels.filter((item) => item.enabled).map((item) => item.id) || []);
  const [recurrence, setRecurrence] = useState<"daily" | "interval_days" | "weekdays">("interval_days");
  const [intervalDays, setIntervalDays] = useState(4);
  const [weekdays, setWeekdays] = useState<number[]>([1, 3, 5]);
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [times, setTimes] = useState("19:30");
  const [mode, setMode] = useState<"approval" | "autopilot">("approval");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!supabase || !channelIds.length) return;
    const parsedTimes = times.split(",").map((value) => value.trim()).filter((value) => /^\d{2}:\d{2}$/.test(value));
    if (!parsedTimes.length) { onError("Ingresa al menos un horario en formato 19:30."); return; }
    const startsAt = new Date(`${startDate}T${parsedTimes[0]}:00`);
    setSaving(true);
    const { error } = await supabase.from("content_schedules").insert({
      name,
      channel_ids: channelIds,
      recurrence_type: recurrence,
      recurrence_rule: { interval_days: intervalDays, weekdays, times: parsedTimes },
      product_filter: {},
      operation_mode: mode,
      starts_at: startsAt.toISOString(),
      next_run_at: startsAt.toISOString(),
      created_by: user?.id,
      updated_by: user?.id,
    });
    setSaving(false);
    if (error) onError(error.message);
    else { await data.refresh(); onSaved("Regla editorial guardada."); }
  }

  return <form className="panel content-schedule-form" onSubmit={submit}><div className="panel-heading"><div><h2>Nueva regla editorial</h2><span>Frecuencia, canales y modo de operación</span></div><button className="ghost-button" type="button" onClick={onClose}>Cerrar</button></div><div className="form-grid"><label><span>Nombre</span><input required value={name} onChange={(event) => setName(event.target.value)} /></label><label><span>Frecuencia</span><select value={recurrence} onChange={(event) => setRecurrence(event.target.value as typeof recurrence)}><option value="daily">Todos los días</option><option value="interval_days">Cada X días</option><option value="weekdays">Días de la semana</option></select></label>{recurrence === "interval_days" ? <label><span>Cada cuántos días</span><input type="number" min={1} max={90} value={intervalDays} onChange={(event) => setIntervalDays(Number(event.target.value))} /></label> : null}<label><span>Fecha de inicio</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label><span>Horarios</span><input value={times} onChange={(event) => setTimes(event.target.value)} placeholder="09:00, 19:30" /></label><label><span>Modo</span><select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="approval">Con aprobación</option><option value="autopilot" disabled={user?.role !== "administrador"}>Piloto automático</option></select></label><fieldset className="wide-field content-channel-picker"><legend>Canales</legend>{data.bootstrap?.channels.map((channel) => <button className={channelIds.includes(channel.id) ? "active" : ""} disabled={!channel.enabled} title={channel.enabled ? channel.name : `${channel.name} no está conectado`} type="button" key={channel.id} onClick={() => setChannelIds((current) => current.includes(channel.id) ? current.filter((id) => id !== channel.id) : [...current, channel.id])}>{channel.name}</button>)}</fieldset>{recurrence === "weekdays" ? <fieldset className="wide-field content-weekday-picker"><legend>Días</legend>{["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"].map((label, index) => <button className={weekdays.includes(index) ? "active" : ""} type="button" key={label} onClick={() => setWeekdays((current) => current.includes(index) ? current.filter((day) => day !== index) : [...current, index])}>{label}</button>)}</fieldset> : null}</div><div className="form-actions"><button className="primary-button" type="submit" disabled={saving || !channelIds.length}><Plus size={17} /> {saving ? "Guardando..." : "Guardar regla"}</button></div></form>;
}

function CalendarEntry({ publication, data, draggable }: { publication: ContentPublication; data: ContentCenterData; draggable: boolean }) {
  const product = data.products.find((item) => item.id === publication.product_id);
  const channel = data.bootstrap?.channels.find((item) => item.id === publication.channel_id);
  return <article className={`content-calendar-entry ${publication.status}`} draggable={draggable} onDragStart={(event) => event.dataTransfer.setData("text/publication-id", publication.id)} title={publication.body}><strong>{channel?.name || "Red"}</strong><span>{product?.name || "Sin producto"}</span><time>{new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit" }).format(publicationDate(publication))}</time></article>;
}

function CalendarList({ entries, data }: { entries: ContentPublication[]; data: ContentCenterData }) {
  return <section className="panel content-calendar-list">{entries.sort((a, b) => publicationDate(a).getTime() - publicationDate(b).getTime()).map((item) => <div key={item.id}><time>{formatDateTime((item.scheduled_at || item.published_at)!)}</time><div><strong>{data.products.find((product) => product.id === item.product_id)?.name || "Sin producto"}</strong><span>{data.bootstrap?.channels.find((channel) => channel.id === item.channel_id)?.name || "Canal"}</span></div><span className={`content-state ${item.status}`}>{item.status}</span></div>)}{!entries.length ? <div className="empty-state"><List size={26} /><span>No hay publicaciones con estos filtros.</span></div> : null}</section>;
}

function publicationDate(item: ContentPublication) { return new Date(item.scheduled_at || item.published_at || item.created_at); }
function startOfDay(value: Date) { const result = new Date(value); result.setHours(0, 0, 0, 0); return result; }
function sameDay(left: Date, right: Date) { return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate(); }
function weekDays(cursor: Date) { const day = cursor.getDay() || 7; const monday = new Date(cursor); monday.setDate(cursor.getDate() - day + 1); return Array.from({ length: 7 }, (_, index) => { const value = new Date(monday); value.setDate(monday.getDate() + index); return value; }); }
function monthDays(cursor: Date) { const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1); const start = weekDays(first)[0]; return Array.from({ length: 42 }, (_, index) => { const value = new Date(start); value.setDate(start.getDate() + index); return value; }); }
function formatDate(value: Date) { return new Intl.DateTimeFormat("es-CL", { day: "numeric", month: "short" }).format(value); }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function scheduleLabel(type: string, rule: Record<string, unknown>) { if (type === "daily") return "Todos los días"; if (type === "weekdays") return `Días ${Array.isArray(rule.weekdays) ? rule.weekdays.join(", ") : "definidos"}`; return `Cada ${Number(rule.interval_days || 1)} días`; }
