import { FormEvent, useEffect, useState } from "react";
import { Database, Mail, MessageCircle, Send, ShieldCheck, Unplug, Users } from "lucide-react";
import { getSupabaseFunctionUrl, isSupabaseConfigured, supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthContext";

interface WhatsAppSettingsForm {
  id?: string;
  phoneNumberId: string;
  businessAccountId: string;
  officialPhoneNumber: string;
  accessTokenHint: string;
  active: boolean;
  lastConnectionStatus: string;
  lastConnectionCheckedAt: string;
  lastError: string;
}

const emptyWhatsAppSettings: WhatsAppSettingsForm = {
  phoneNumberId: "",
  businessAccountId: "",
  officialPhoneNumber: "",
  accessTokenHint: "",
  active: false,
  lastConnectionStatus: "sin_configurar",
  lastConnectionCheckedAt: "",
  lastError: "",
};

interface GmailStatus {
  connected: boolean;
  connectedEmail: string | null;
  status: string;
  dailyLimit: number;
  sentToday: number;
  lastConnectedAt: string | null;
  lastHealthCheckAt: string | null;
  lastError: string | null;
}

const emptyGmailStatus: GmailStatus = {
  connected: false,
  connectedEmail: null,
  status: "disconnected",
  dailyLimit: 50,
  sentToday: 0,
  lastConnectedAt: null,
  lastHealthCheckAt: null,
  lastError: null,
};

export function AdminPage() {
  const { user } = useAuth();
  const [whatsappSettings, setWhatsappSettings] = useState<WhatsAppSettingsForm>(emptyWhatsAppSettings);
  const [savingWhatsApp, setSavingWhatsApp] = useState(false);
  const [whatsappNotice, setWhatsappNotice] = useState("");
  const [gmailStatus, setGmailStatus] = useState<GmailStatus>(emptyGmailStatus);
  const [gmailNotice, setGmailNotice] = useState("");
  const [gmailTestEmail, setGmailTestEmail] = useState("");
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailDailyLimit, setGmailDailyLimit] = useState(50);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !user) return;

    async function loadWhatsAppSettings() {
      const { data, error } = await supabase!
        .from("whatsapp_settings")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        setWhatsappNotice("Ejecuta primero supabase/whatsapp_meta_integration.sql para activar esta seccion.");
        return;
      }

      if (data) {
        setWhatsappSettings({
          id: String(data.id),
          phoneNumberId: String(data.phone_number_id ?? ""),
          businessAccountId: String(data.business_account_id ?? ""),
          officialPhoneNumber: String(data.official_phone_number ?? ""),
          accessTokenHint: String(data.access_token_hint ?? ""),
          active: Boolean(data.active),
          lastConnectionStatus: String(data.last_connection_status ?? "sin_probar"),
          lastConnectionCheckedAt: String(data.last_connection_checked_at ?? ""),
          lastError: String(data.last_error ?? ""),
        });
      }
    }

    void loadWhatsAppSettings();
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("gmail") === "connected") setGmailNotice("Gmail conectado correctamente.");
    if (params.get("gmail") === "error") setGmailNotice(`Error Gmail: ${params.get("message") || "revisa la configuracion"}.`);
    void loadGmailStatus();
  }, [user]);

  async function getAuthHeaders() {
    if (!isSupabaseConfigured || !supabase) throw new Error("Conecta Supabase para usar Gmail API.");
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Sesion requerida.");
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  async function callGmailFunction(route: string, options: RequestInit = {}) {
    const headers = await getAuthHeaders();
    const functionUrl = getSupabaseFunctionUrl("gmail-integration", route);
    let response: Response;
    try {
      response = await fetch(functionUrl, {
        ...options,
        headers: {
          ...headers,
          ...(options.headers || {}),
        },
      });
    } catch {
      throw new Error("No se pudo contactar la Edge Function gmail-integration. Esta creada localmente, pero falta servirla localmente o desplegarla en tu Supabase.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `No se pudo contactar la Edge Function gmail-integration (${response.status}). Revisa que este servida o desplegada en Supabase.`);
    }
    return data;
  }

  async function loadGmailStatus() {
    if (!isSupabaseConfigured || !supabase || !user) {
      setGmailNotice("Modo demo: conecta Supabase para activar Gmail API.");
      return;
    }

    try {
      const data = await callGmailFunction("status");
      setGmailStatus(data as GmailStatus);
      setGmailDailyLimit(Number(data.dailyLimit ?? 50));
    } catch (error) {
      setGmailNotice(error instanceof Error ? error.message : "No se pudo cargar Gmail.");
    }
  }

  async function connectGmail() {
    setGmailBusy(true);
    setGmailNotice("");
    try {
      const returnTo = `${window.location.origin}/administracion`;
      const data = await callGmailFunction(`auth?return_to=${encodeURIComponent(returnTo)}`);
      window.location.href = String(data.authUrl);
    } catch (error) {
      setGmailNotice(error instanceof Error ? error.message : "No se pudo iniciar OAuth Gmail.");
      setGmailBusy(false);
    }
  }

  async function disconnectGmail() {
    setGmailBusy(true);
    setGmailNotice("");
    try {
      await callGmailFunction("disconnect", { method: "POST", body: "{}" });
      setGmailNotice("Gmail desconectado.");
      await loadGmailStatus();
    } catch (error) {
      setGmailNotice(error instanceof Error ? error.message : "No se pudo desconectar Gmail.");
    } finally {
      setGmailBusy(false);
    }
  }

  async function saveGmailSettings() {
    setGmailBusy(true);
    setGmailNotice("");
    try {
      await callGmailFunction("settings", {
        method: "POST",
        body: JSON.stringify({ dailyLimit: gmailDailyLimit }),
      });
      setGmailNotice("Configuracion Gmail guardada.");
      await loadGmailStatus();
    } catch (error) {
      setGmailNotice(error instanceof Error ? error.message : "No se pudo guardar Gmail.");
    } finally {
      setGmailBusy(false);
    }
  }

  async function sendGmailTest() {
    setGmailBusy(true);
    setGmailNotice("");
    try {
      await callGmailFunction("send-test", {
        method: "POST",
        body: JSON.stringify({ toEmail: gmailTestEmail }),
      });
      setGmailNotice("Correo de prueba enviado.");
      await loadGmailStatus();
    } catch (error) {
      setGmailNotice(error instanceof Error ? error.message : "No se pudo enviar la prueba.");
    } finally {
      setGmailBusy(false);
    }
  }

  async function saveWhatsAppSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!isSupabaseConfigured || !supabase) {
      setWhatsappNotice("Modo demo: conecta Supabase para guardar la configuracion.");
      return;
    }

    setSavingWhatsApp(true);
    setWhatsappNotice("");

    const payload = {
      phone_number_id: whatsappSettings.phoneNumberId,
      business_account_id: whatsappSettings.businessAccountId,
      official_phone_number: whatsappSettings.officialPhoneNumber || null,
      access_token_hint: whatsappSettings.accessTokenHint || null,
      active: whatsappSettings.active,
      last_connection_status: whatsappSettings.lastConnectionStatus,
      updated_by: user?.id,
      created_by: user?.id,
    };

    const request = whatsappSettings.id
      ? supabase.from("whatsapp_settings").update(payload).eq("id", whatsappSettings.id).select("*").single()
      : supabase.from("whatsapp_settings").insert(payload).select("*").single();

    const { data, error } = await request;
    setSavingWhatsApp(false);

    if (error) {
      setWhatsappNotice(error.message);
      return;
    }

    setWhatsappSettings((current) => ({ ...current, id: String(data.id) }));
    setWhatsappNotice("Configuracion WhatsApp guardada. Los secretos deben configurarse como variables de entorno del backend.");
  }

  function markConnectionCheck() {
    setWhatsappSettings((current) => ({
      ...current,
      lastConnectionStatus: current.phoneNumberId && current.businessAccountId ? "pendiente_prueba_backend" : "incompleta",
      lastConnectionCheckedAt: new Date().toISOString(),
      lastError: current.phoneNumberId && current.businessAccountId ? "" : "Faltan Phone Number ID o WABA ID.",
    }));
    setWhatsappNotice("Prueba real pendiente: requiere META_WHATSAPP_ACCESS_TOKEN configurado en la Edge Function.");
  }

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <p>Configuracion y seguridad</p>
          <h1>Administracion</h1>
        </div>
      </div>

      <div className="admin-grid">
        <article className="panel admin-card">
          <Users size={24} />
          <h2>Usuarios y roles</h2>
          <p>Roles base: administrador, vendedor y visualizador. Listo para sincronizar con profiles en Supabase.</p>
        </article>
        <article className="panel admin-card">
          <ShieldCheck size={24} />
          <h2>Seguridad</h2>
          <p>Rutas protegidas, validacion de sesion y preparacion para politicas RLS por organizacion.</p>
        </article>
        <article className="panel admin-card">
          <Database size={24} />
          <h2>Supabase</h2>
          <p>{isSupabaseConfigured ? "Variables de Supabase configuradas." : "Modo demo: agrega VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY."}</p>
        </article>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <h2>Integraciones futuras</h2>
        </div>
        <div className="integration-list">
          {["Importacion CSV/Excel", "Google Calendar", "Facturacion"].map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        <p className="muted integration-note">
          Estas integraciones quedan planificadas para una etapa posterior. Gmail y WhatsApp usan backend seguro para evitar secretos en el navegador.
        </p>
      </div>

      <div className="panel admin-integration-form">
        <div className="panel-heading">
          <div>
            <h2>Integracion Gmail</h2>
            <span>OAuth2 seguro para enviar desde msanhueza@latinchile.cl</span>
          </div>
          <span className={`status-badge ${gmailStatus.connected ? "cliente" : gmailStatus.status === "error" ? "descartado" : "pausada"}`}>
            {gmailStatus.connected ? "conectado" : gmailStatus.status === "error" ? "error" : "desconectado"}
          </span>
        </div>

        <div className="admin-integration-summary">
          <Mail size={24} />
          <div>
            <strong>{gmailStatus.connected ? `Cuenta conectada: ${gmailStatus.connectedEmail}` : "Gmail no conectado"}</strong>
            <p className="muted">
              Client Secret, refresh token y access token viven solo en la Edge Function. El frontend nunca recibe secretos.
            </p>
          </div>
        </div>

        <div className="gmail-status-grid">
          <div>
            <span>Enviados hoy</span>
            <strong>{gmailStatus.sentToday} / {gmailStatus.dailyLimit}</strong>
          </div>
          <div>
            <span>Ultima conexion</span>
            <strong>{gmailStatus.lastConnectedAt ? new Date(gmailStatus.lastConnectedAt).toLocaleString() : "Sin conexion"}</strong>
          </div>
          <div>
            <span>Salud</span>
            <strong>{gmailStatus.lastError ? "Revisar error" : gmailStatus.connected ? "Operativa" : "Pendiente"}</strong>
          </div>
        </div>

        <div className="form-grid">
          <label>
            Limite diario interno
            <input
              type="number"
              min="1"
              max="2000"
              value={gmailDailyLimit}
              onChange={(event) => setGmailDailyLimit(Number(event.target.value))}
            />
          </label>
          <label>
            Correo de prueba
            <input
              type="email"
              placeholder="destinatario@empresa.cl"
              value={gmailTestEmail}
              onChange={(event) => setGmailTestEmail(event.target.value)}
            />
          </label>
        </div>

        {gmailStatus.lastError ? <p className="form-error">{gmailStatus.lastError}</p> : null}
        {gmailNotice ? <p className="muted">{gmailNotice}</p> : null}

        <div className="form-actions">
          <button className="ghost-button" type="button" onClick={loadGmailStatus} disabled={gmailBusy}>
            Revisar estado
          </button>
          <button className="ghost-button" type="button" onClick={saveGmailSettings} disabled={gmailBusy}>
            Guardar limite
          </button>
          <button className="ghost-button" type="button" onClick={sendGmailTest} disabled={gmailBusy || !gmailStatus.connected}>
            <Send size={18} />
            Enviar prueba
          </button>
          {gmailStatus.connected ? (
            <button className="ghost-button danger" type="button" onClick={disconnectGmail} disabled={gmailBusy}>
              <Unplug size={18} />
              Desconectar
            </button>
          ) : (
            <button className="primary-button" type="button" onClick={connectGmail} disabled={gmailBusy}>
              <Mail size={18} />
              Conectar Gmail
            </button>
          )}
        </div>
      </div>

      <form className="panel admin-integration-form" onSubmit={saveWhatsAppSettings}>
        <div className="panel-heading">
          <div>
            <h2>Integracion WhatsApp Meta</h2>
            <span>Configuracion segura para Meta Cloud API</span>
          </div>
          <span className={`status-badge ${whatsappSettings.active ? "cliente" : "pausada"}`}>
            {whatsappSettings.active ? "activa" : "inactiva"}
          </span>
        </div>

        <div className="admin-integration-summary">
          <MessageCircle size={24} />
          <div>
            <strong>Estado de conexion: {whatsappSettings.lastConnectionStatus}</strong>
            <p className="muted">
              El Access Token y el Webhook Verify Token no se guardan en el navegador. Configuralos como secretos del backend:
              {" "}META_WHATSAPP_ACCESS_TOKEN, META_WHATSAPP_PHONE_NUMBER_ID, META_WHATSAPP_WEBHOOK_VERIFY_TOKEN y META_WHATSAPP_APP_SECRET.
            </p>
          </div>
        </div>

        <div className="form-grid">
          <label>
            Phone Number ID
            <input
              value={whatsappSettings.phoneNumberId}
              onChange={(event) => setWhatsappSettings({ ...whatsappSettings, phoneNumberId: event.target.value })}
            />
          </label>
          <label>
            WhatsApp Business Account ID
            <input
              value={whatsappSettings.businessAccountId}
              onChange={(event) => setWhatsappSettings({ ...whatsappSettings, businessAccountId: event.target.value })}
            />
          </label>
          <label>
            Numero oficial WhatsApp
            <input
              value={whatsappSettings.officialPhoneNumber}
              onChange={(event) => setWhatsappSettings({ ...whatsappSettings, officialPhoneNumber: event.target.value })}
            />
          </label>
          <label>
            Hint token
            <input
              placeholder="Ej: termina en ...ABCD"
              value={whatsappSettings.accessTokenHint}
              onChange={(event) => setWhatsappSettings({ ...whatsappSettings, accessTokenHint: event.target.value })}
            />
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={whatsappSettings.active}
              onChange={(event) => setWhatsappSettings({ ...whatsappSettings, active: event.target.checked })}
            />
            Integracion activa
          </label>
        </div>

        {whatsappSettings.lastConnectionCheckedAt ? (
          <p className="muted">Ultima revision: {new Date(whatsappSettings.lastConnectionCheckedAt).toLocaleString()}</p>
        ) : null}
        {whatsappSettings.lastError ? <p className="form-error">{whatsappSettings.lastError}</p> : null}
        {whatsappNotice ? <p className="muted">{whatsappNotice}</p> : null}

        <div className="form-actions">
          <button className="ghost-button" type="button" onClick={markConnectionCheck}>
            Probar conexion
          </button>
          <button className="ghost-button" type="button" disabled title="Disponible cuando el backend de prueba quede configurado">
            Enviar mensaje de prueba
          </button>
          <button className="primary-button" type="submit" disabled={savingWhatsApp}>
            {savingWhatsApp ? "Guardando..." : "Guardar configuracion"}
          </button>
        </div>
      </form>
    </section>
  );
}
