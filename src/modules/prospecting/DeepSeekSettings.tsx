import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Unplug, X } from "lucide-react";
import { requestDeepSeekSettings, type DeepSeekStatus } from "../../lib/prospectingIntegrationsApi";
import "./deepseekSettings.css";

export function DeepSeekSettings({ enabled }: { enabled: boolean }) {
  const [connection, setConnection] = useState<DeepSeekStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const active = useRef(false);
  const inFlight = useRef(false);
  const request = useRef<AbortController | null>(null);

  async function run(action: "status" | "save" | "verify" | "disconnect") {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(action); setError(""); setMessage("");
    const controller = new AbortController();
    request.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 60000);
    try {
      const result = await requestDeepSeekSettings(action, action === "save" ? apiKey : undefined, controller.signal);
      if (!active.current || controller.signal.aborted) return;
      setConnection(result);
      if (action !== "status") {
        setApiKey(""); setVisible(false); setConfirmDisconnect(false);
        setMessage(action === "disconnect" ? "Clave eliminada del CRM." : result.status === "verified"
          ? "Credencial verificada. Las búsquedas automáticas siguen sin activar."
          : "La configuración cambió durante la verificación. Revisa el estado actual.");
      }
    } catch (failure) {
      if (!active.current || request.current !== controller) return;
      setError(failure instanceof Error ? failure.message : "No se pudo completar la operación.");
      if (action === "verify") {
        // The stored key remains in place, but a failed check must not appear verified.
        setConnection(previous => previous ? { ...previous, status: "error" } : previous);
      }
    } finally {
      window.clearTimeout(timer);
      if (request.current === controller) {
        inFlight.current = false;
        if (active.current) setBusy("");
      }
    }
  }

  useEffect(() => {
    active.current = true;
    if (enabled) void run("status");
    return () => { active.current = false; request.current?.abort(); inFlight.current = false; };
    // Reload only when the real CRM connection becomes available, never on key entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  function save(event: FormEvent) { event.preventDefault(); void run("save"); }
  const available = enabled && connection?.ready;
  const statusLabel = !enabled ? "No disponible en demo" : busy === "status" ? "Consultando estado"
    : !connection ? "Estado no disponible" : !connection.ready ? "Instalación pendiente"
      : connection.status === "verified" ? "Credencial verificada" : connection.status === "error" ? "Requiere revisión" : "Sin conectar";
  const checkedAt = connection?.lastCheckedAt ? new Date(connection.lastCheckedAt) : null;

  return (
    <section className="deepseek-settings" aria-labelledby="deepseek-title">
      <header className="deepseek-header">
        <div><p className="deepseek-eyebrow"><ShieldCheck size={16} /> Solo administración</p><h2 id="deepseek-title">DeepSeek API</h2></div>
        <span className={`deepseek-status ${connection?.status === "verified" && connection.ready ? "verified" : ""}`}>
          {busy ? <LoaderCircle className="spin" size={16} /> : connection?.status === "verified" && connection.ready ? <CheckCircle2 size={16} /> : <KeyRound size={16} />}
          {statusLabel}
        </span>
      </header>
      <div className="deepseek-grid">
        <form className="deepseek-form" onSubmit={save}>
          {error ? <div className="deepseek-feedback error" role="alert"><AlertCircle size={18} /><span>{error}</span></div> : null}
          {message ? <div className="deepseek-feedback success" role="status"><CheckCircle2 size={18} /><span>{message}</span></div> : null}
          {enabled && connection && !connection.ready ? <p className="deepseek-feedback" role="status">Falta habilitar el almacenamiento seguro en el servidor.</p> : null}
          {!enabled ? <p className="deepseek-feedback">Conexión no disponible en modo demo. No ingreses credenciales reales.</p> : null}
          <label htmlFor="deepseek-api-key">{connection?.configured ? "Reemplazar clave API" : "Clave API"}</label>
          <div className="deepseek-key-field">
            <input id="deepseek-api-key" name="deepseek-api-key" type={visible ? "text" : "password"}
              value={apiKey} onChange={event => setApiKey(event.target.value)} required minLength={16} maxLength={512}
              autoComplete="new-password" autoCapitalize="none" spellCheck={false} disabled={!available || Boolean(busy)}
              placeholder={connection?.configured ? "Nueva clave" : "Ingresa tu clave de DeepSeek"} aria-describedby="deepseek-key-privacy" />
            <button type="button" className="deepseek-icon-button" title={visible ? "Ocultar clave" : "Mostrar clave"}
              aria-label={visible ? "Ocultar clave" : "Mostrar clave"} aria-pressed={visible}
              onClick={() => setVisible(!visible)} disabled={!available || Boolean(busy)}>
              {visible ? <EyeOff size={19} /> : <Eye size={19} />}
            </button>
          </div>
          <small id="deepseek-key-privacy" className="deepseek-muted">Almacenamiento cifrado en el servidor. La clave guardada no se vuelve a mostrar.</small>
          <div className="deepseek-actions">
            <button className="primary-button" type="submit" disabled={!available || Boolean(busy) || apiKey.trim().length < 16}>
              {busy === "save" ? <LoaderCircle className="spin" size={17} /> : <KeyRound size={17} />} {busy === "save" ? "Verificando…" : "Guardar y verificar"}
            </button>
            <button className="ghost-button" type="button" disabled={!enabled || Boolean(busy)} onClick={() => void run(connection?.configured && available ? "verify" : "status")}>
              <RefreshCw size={17} /> {connection?.configured && available ? "Verificar conexión" : "Actualizar estado"}
            </button>
          </div>
        </form>
        <aside className="deepseek-details" aria-label="Estado de la integración">
          <dl>
            <div><dt>Credencial</dt><dd>{connection ? connection.configured ? "Guardada y cifrada" : "Sin guardar" : "Sin consultar"}</dd></div>
            <div><dt>Búsqueda automática con DeepSeek</dt><dd>No activada</dd></div>
            <div><dt>Última verificación</dt><dd>{checkedAt && !Number.isNaN(checkedAt.getTime()) ? new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", dateStyle: "medium", timeStyle: "short" }).format(checkedAt) : "Sin verificar"}</dd></div>
            {connection?.status === "verified" ? <div><dt>Modelos disponibles</dt><dd>{connection.models.length}</dd></div> : null}
          </dl>
          {connection?.configured ? confirmDisconnect ? (
            <div className="deepseek-disconnect">
              <p>¿Eliminar la clave guardada del CRM?</p>
              <div className="deepseek-actions">
                <button className="ghost-button" type="button" disabled={Boolean(busy)} onClick={() => void run("disconnect")}><Unplug size={17} /> Eliminar clave</button>
                <button className="deepseek-icon-button" type="button" title="Cancelar" aria-label="Cancelar eliminación" disabled={Boolean(busy)} onClick={() => setConfirmDisconnect(false)}><X size={18} /></button>
              </div>
            </div>
          ) : <button className="ghost-button" type="button" disabled={Boolean(busy)} onClick={() => setConfirmDisconnect(true)}><Unplug size={17} /> Desconectar</button> : null}
        </aside>
      </div>
    </section>
  );
}
