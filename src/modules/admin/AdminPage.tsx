import { FormEvent, useEffect, useState } from "react";
import { Database, Mail, MapPinned, MessageCircle, RefreshCw, Save, Send, ShieldCheck, Unplug, Users } from "lucide-react";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthContext";
import {
  type GmailStatus,
  emptyGmailStatus,
  getGmailStatus,
  getGmailAuthUrl,
  disconnectGmail as apiDisconnectGmail,
  saveGmailSettings as apiSaveGmailSettings,
  sendGmailTest as apiSendGmailTest,
} from "../../lib/gmailApi";

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

interface ProspectingIntegrationStatus {
  provider: "google_places" | "brave_search";
  configured: boolean;
  status: "not_configured" | "pending" | "checking" | "connected" | "quota_exhausted" | "error";
  message: string;
  error_code: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  metadata: Record<string, unknown>;
}

interface BravePolicy {
  monthlyLimitUsd: number;
  freeCreditUsd: number;
  socialSearchEnabled: boolean;
  maxSocialQueries: number;
}

export function AdminPage() {
  const { user } = useAuth();
  const [whatsappSettings, setWhatsappSettings] = useState<WhatsAppSettingsForm>(emptyWhatsAppSettings);
  const [savingWhatsApp, setSavingWhatsApp] = useState(false);
  const [whatsappNotice, setWhatsappNotice] = useState("");
  const [gmailStatus, setGmailStatus] = useState<GmailStatus>(emptyGmailStatus);
  const [gmailNotice, setGmailNotice] = useState("");
  const [gmailNoticeType, setGmailNoticeType] = useState<"info" | "success" | "error">("info");
  const [gmailTestEmail, setGmailTestEmail] = useState("");
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailDailyLimit, setGmailDailyLimit] = useState(50);
  const [prospectingIntegrations, setProspectingIntegrations] = useState<ProspectingIntegrationStatus[]>([]);
  const [integrationBusy, setIntegrationBusy] = useState<ProspectingIntegrationStatus["provider"] | null>(null);
  const [integrationNotice, setIntegrationNotice] = useState("");
  const [bravePolicy, setBravePolicy] = useState<BravePolicy>({ monthlyLimitUsd: 5, freeCreditUsd: 5, socialSearchEnabled: false, maxSocialQueries: 6 });
  const [savingBravePolicy, setSavingBravePolicy] = useState(false);

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
    void loadProspectingIntegrations();
  }, [user]);

  async function loadProspectingIntegrations() {
    if (!isSupabaseConfigured || !supabase || !user) return;
    const { data, error } = await supabase
      .from("prospecting_integration_status")
      .select("provider,configured,status,message,error_code,last_checked_at,last_success_at,metadata")
      .order("provider");
    if (error) {
      setIntegrationNotice("Falta instalar la actualizacion de integraciones de prospeccion en Supabase.");
      return;
    }
    setProspectingIntegrations((data ?? []) as ProspectingIntegrationStatus[]);
    const { data: policy } = await supabase.from("prospecting_provider_settings").select("monthly_limit_usd,free_credit_usd,social_search_enabled,max_social_queries_per_campaign").eq("provider", "brave_search").maybeSingle();
    if (policy) setBravePolicy({ monthlyLimitUsd: Number(policy.monthly_limit_usd), freeCreditUsd: Number(policy.free_credit_usd), socialSearchEnabled: Boolean(policy.social_search_enabled), maxSocialQueries: Number(policy.max_social_queries_per_campaign) });
  }

  async function saveBravePolicy() {
    if (!supabase || !user) return;
    setSavingBravePolicy(true);
    const { error } = await supabase.from("prospecting_provider_settings").update({
      monthly_limit_usd: bravePolicy.monthlyLimitUsd,
      free_credit_usd: bravePolicy.freeCreditUsd,
      social_search_enabled: bravePolicy.socialSearchEnabled,
      max_social_queries_per_campaign: bravePolicy.maxSocialQueries,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    }).eq("provider", "brave_search");
    setSavingBravePolicy(false);
    setIntegrationNotice(error ? error.message : "Control de gasto Brave guardado. Se aplicará a las próximas ejecuciones.");
  }

  async function testProspectingIntegration(provider: ProspectingIntegrationStatus["provider"]) {
    if (!supabase) return;
    setIntegrationBusy(provider);
    setIntegrationNotice("Solicitando una prueba segura al agente...");
    const { error } = await supabase.rpc("request_prospecting_integration_check", {
      p_provider: provider,
    });
    if (error) {
      setIntegrationBusy(null);
      setIntegrationNotice(error.message);
      return;
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      await loadProspectingIntegrations();
      const { data } = await supabase
        .from("prospecting_integration_status")
        .select("status,message")
        .eq("provider", provider)
        .maybeSingle();
      if (data && !["pending", "checking"].includes(String(data.status))) {
        setIntegrationNotice(String(data.message ?? "Prueba finalizada."));
        setIntegrationBusy(null);
        return;
      }
    }
    setIntegrationNotice("La prueba sigue pendiente. Pulsa Revisar estado en unos segundos.");
    setIntegrationBusy(null);
  }

  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("gmail") === "connected") {
      setGmailNoticeType("success");
      setGmailNotice("Gmail conectado correctamente.");
    }
    if (params.get("gmail") === "error") {
      setGmailNoticeType("error");
      setGmailNotice(`Error Gmail: ${params.get("message") || "revisa la configuracion"}.`);
    }
    void loadGmailStatusData();
  }, [user]);

  async function loadGmailStatusData() {
    if (!isSupabaseConfigured || !supabase || !user) {
      setGmailNoticeType("info");
      setGmailNotice("Modo demo: conecta Supabase para activar Gmail API.");
      return;
    }

    try {
      const data = await getGmailStatus();
      setGmailStatus(data);
      setGmailDailyLimit(Number(data.dailyLimit ?? 50));
    } catch (error) {
      setGmailNoticeType("error");
      setGmailNotice(error instanceof Error ? error.message : "No se pudo cargar Gmail.");
    }
  }

  async function connectGmail() {
    setGmailBusy(true);
    setGmailNoticeType("info");
    setGmailNotice("");
    try {
      const returnTo = `${window.location.origin}/administracion`;
      const authUrl = await getGmailAuthUrl(returnTo);
      window.location.href = authUrl;
    } catch (error) {
      setGmailNoticeType("error");
      setGmailNotice(error instanceof Error ? error.message : "No se pudo iniciar OAuth Gmail.");
      setGmailBusy(false);
    }
  }

  async function disconnectGmail() {
    setGmailBusy(true);
    setGmailNoticeType("info");
    setGmailNotice("");
    try {
      await apiDisconnectGmail();
      setGmailNoticeType("success");
      setGmailNotice("Gmail desconectado.");
      await loadGmailStatusData();
    } catch (error) {
      setGmailNoticeType("error");
      setGmailNotice(error instanceof Error ? error.message : "No se pudo desconectar Gmail.");
    } finally {
      setGmailBusy(false);
    }
  }

  async function saveGmailSettings() {
    setGmailBusy(true);
    setGmailNoticeType("info");
    setGmailNotice("");
    try {
      await apiSaveGmailSettings(gmailDailyLimit);
      setGmailNoticeType("success");
      setGmailNotice("Configuracion Gmail guardada.");
      await loadGmailStatusData();
    } catch (error) {
      setGmailNoticeType("error");
      setGmailNotice(error instanceof Error ? error.message : "No se pudo guardar Gmail.");
    } finally {
      setGmailBusy(false);
    }
  }

  async function sendGmailTest() {
    if (!gmailTestEmail.trim()) {
      setGmailNoticeType("error");
      setGmailNotice("Ingresa un correo de prueba antes de enviar.");
      return;
    }

    setGmailBusy(true);
    setGmailNoticeType("info");
    setGmailNotice("Enviando correo de prueba...");
    console.info("[gmail-admin] Enviando correo de prueba", { toEmail: gmailTestEmail });
    try {
      const data = await apiSendGmailTest(gmailTestEmail);
      setGmailNoticeType("success");
      setGmailNotice(data.message || "Correo de prueba enviado.");
      console.info("[gmail-admin] Correo de prueba enviado", data);
      await loadGmailStatusData();
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo enviar la prueba.";
      setGmailNoticeType("error");
      console.error("[gmail-admin] Error enviando correo de prueba", { error: message });
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

      <div className="panel admin-integration-form">
        <div className="panel-heading">
          <div>
            <h2>Fuentes del agente buscador</h2>
            <span>Conexiones del worker de prospeccion; las claves permanecen fuera del CRM.</span>
          </div>
        </div>

        {(() => {
          return (
            <>
              {([
                ["google_places", "Google Places API", "Probar Google Places"],
                ["brave_search", "Brave Search API", "Probar Brave Search"],
              ] as const).map(([provider, title, action]) => {
                const integration = prospectingIntegrations.find((item) => item.provider === provider);
                const connected = integration?.status === "connected";
                const pending = integration?.status === "pending" || integration?.status === "checking";
                const busy = integrationBusy === provider;
                return (
                  <div key={provider} className="admin-integration-source">
                    <div className="admin-integration-summary">
                      <MapPinned size={24} />
                      <div>
                        <strong>{title}</strong>
                        <p className="muted">
                          {integration?.message ?? "Sin informacion del agente."} La clave nunca se muestra ni se guarda en el navegador.
                        </p>
                      </div>
                      <span className={`status-badge ${connected ? "cliente" : integration?.status === "error" ? "descartado" : "pausada"}`}>
                        {connected ? "conectado" : pending ? "probando" : integration?.configured ? "revisar" : "sin verificar"}
                      </span>
                    </div>
                    <div className="gmail-status-grid">
                      <div><span>Configuracion</span><strong>{integration?.configured ? "Clave detectada" : "No confirmada"}</strong></div>
                      <div><span>Ultima prueba</span><strong>{integration?.last_checked_at ? new Date(integration.last_checked_at).toLocaleString() : "Sin prueba"}</strong></div>
                      <div><span>Ultimo exito</span><strong>{integration?.last_success_at ? new Date(integration.last_success_at).toLocaleString() : "Pendiente"}</strong></div>
                    </div>
                    <div className="form-actions">
                      <button className="ghost-button" type="button" onClick={loadProspectingIntegrations} disabled={Boolean(integrationBusy)}><RefreshCw size={18} />Revisar estado</button>
                      <button className="primary-button" type="button" onClick={() => testProspectingIntegration(provider)} disabled={Boolean(integrationBusy)}><MapPinned size={18} />{busy ? "Probando..." : action}</button>
                    </div>
                  </div>
                );
              })}
              {integrationNotice ? <p className="muted">{integrationNotice}</p> : null}
              {(() => {
                const brave = prospectingIntegrations.find((item) => item.provider === "brave_search");
                const used = Number(brave?.metadata?.monthly_queries ?? 0);
                const spent = Number(brave?.metadata?.monthly_spend_usd ?? 0);
                const providerUsed = Number(brave?.metadata?.provider_queries ?? 0);
                const providerSpent = Number(brave?.metadata?.provider_spend_usd ?? 0);
                const providerSyncedAt = String(brave?.metadata?.provider_synced_at ?? "");
                const reconciled = Boolean(providerSyncedAt);
                const remaining = Math.max(0, bravePolicy.monthlyLimitUsd - spent);
                const estimatedNext = Number(brave?.metadata?.cost_per_query_usd ?? 0.005) * 8;
                return <div className="admin-integration-source">
                  <div className="panel-heading"><div><h2>Control mensual de Brave</h2><span>El agente detiene nuevas consultas automáticamente al alcanzar este límite.</span></div></div>
                  <div className="gmail-status-grid">
                      <div><span>Consumo oficial Brave</span><strong>{reconciled ? `US$${providerSpent.toFixed(2)}` : "Pendiente"}</strong></div>
                      <div><span>Consultas oficiales</span><strong>{reconciled ? providerUsed : "—"}</strong></div>
                      <div><span>Consumo reconciliado</span><strong>US${spent.toFixed(3)}</strong></div>
                      <div><span>Consultas controladas</span><strong>{used}</strong></div>
                      <div><span>Crédito disponible</span><strong>US${remaining.toFixed(2)}</strong></div>
                    <div><span>Próxima ejecución base</span><strong>≈ US${estimatedNext.toFixed(3)}</strong></div>
                  </div>
                  <div className="form-grid">
                    <label><span>Límite mensual (USD)</span><select value={bravePolicy.monthlyLimitUsd} onChange={(event) => setBravePolicy((current) => ({ ...current, monthlyLimitUsd: Number(event.target.value) }))}><option value={5}>US$5</option><option value={10}>US$10</option><option value={20}>US$20</option></select></label>
                    <label><span>Máximo de consultas sociales por campaña</span><input type="number" min={0} max={100} value={bravePolicy.maxSocialQueries} onChange={(event) => setBravePolicy((current) => ({ ...current, maxSocialQueries: Number(event.target.value) }))} /></label>
                    <label className="checkbox-row"><input type="checkbox" checked={bravePolicy.socialSearchEnabled} onChange={(event) => setBravePolicy((current) => ({ ...current, socialSearchEnabled: event.target.checked }))} /><span>Buscar también en Instagram y Facebook</span></label>
                  </div>
                    <p className="muted">{reconciled ? `Última sincronización oficial: ${new Date(providerSyncedAt).toLocaleString("es-CL")}. ` : "Pulsa Probar Brave Search para sincronizar el consumo oficial. "}La investigación posterior de sitios oficiales consume 0 consultas Brave. La búsqueda social sólo se habilita con este interruptor.</p>
                  <div className="form-actions"><button className="primary-button" type="button" onClick={saveBravePolicy} disabled={savingBravePolicy}><Save size={18} />{savingBravePolicy ? "Guardando..." : "Guardar control de gasto"}</button></div>
                </div>;
              })()}
            </>
          );
        })()}
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
        {gmailNotice ? <p className={`gmail-notice ${gmailNoticeType}`}>{gmailNotice}</p> : null}

        <div className="form-actions">
          <button className="ghost-button" type="button" onClick={loadGmailStatusData} disabled={gmailBusy}>
            Revisar estado
          </button>
          <button className="ghost-button" type="button" onClick={saveGmailSettings} disabled={gmailBusy}>
            Guardar limite
          </button>
          <button className="ghost-button" type="button" onClick={sendGmailTest} disabled={gmailBusy}>
            <Send size={18} />
            {gmailBusy ? "Enviando..." : "Enviar prueba"}
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
