import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type SupabaseClient = ReturnType<typeof createClient>;

type AuthenticatedUser = {
  id: string;
  email: string;
  role: string;
};

type GmailIntegration = {
  id: string;
  connected_email: string | null;
  refresh_token_encrypted: string | null;
  status: string;
  daily_limit: number;
  sent_today: number;
  sent_today_date: string;
  last_connected_at: string | null;
  last_health_check_at: string | null;
  last_error: string | null;
};

type CampaignRecipient = {
  companyId?: string;
  toEmail: string;
  variables?: Record<string, string>;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json; charset=utf-8",
};

const gmailSendScope = "https://www.googleapis.com/auth/gmail.send";
const identityScopes = "openid email";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const url = new URL(req.url);
    const route = getRoute(url);

    if (route === "health") return json({ ok: true, service: "gmail-integration" });
    if (route === "callback" && req.method === "GET") return handleCallback(url, supabase);

    const user = await requireAdmin(req, supabase);

    if (route === "auth" && req.method === "GET") return handleAuth(url, supabase, user);
    if (route === "status" && req.method === "GET") return handleStatus(supabase);
    if (route === "metrics" && req.method === "GET") return handleMetrics(supabase);
    if (route === "settings" && req.method === "POST") return handleSettings(req, supabase, user);
    if (route === "disconnect" && req.method === "POST") return handleDisconnect(supabase, user);
    if ((route === "send-test" || route === "test-send") && req.method === "POST") return handleSendTest(req, supabase, user);
    if (route === "send-campaign" && req.method === "POST") return handleSendCampaign(req, supabase, user);

    return json({ error: "Route not found" }, 404);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    return json({ error: message }, status);
  }
});

async function handleAuth(url: URL, supabase: SupabaseClient, user: AuthenticatedUser) {
  const clientId = requiredEnv("GOOGLE_CLIENT_ID");
  const redirectUri = requiredEnv("GOOGLE_REDIRECT_URI");
  const sender = requiredEnv("GOOGLE_GMAIL_SENDER").toLowerCase();
  const redirectAfter = url.searchParams.get("return_to") || "/administracion?gmail=connected";
  const state = crypto.randomUUID();

  const { error } = await supabase.from("gmail_oauth_states").insert({
    state,
    user_id: user.id,
    redirect_after: redirectAfter,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (error) throw new HttpError(`Could not create OAuth state: ${error.message}`, 500);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    scope: `${gmailSendScope} ${identityScopes}`,
    state,
    login_hint: sender,
  });

  return json({ authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
}

async function handleCallback(url: URL, supabase: SupabaseClient) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) return redirectToAdmin(`/administracion?gmail=error&message=${encodeURIComponent(oauthError)}`);
  if (!code || !state) return redirectToAdmin("/administracion?gmail=error&message=missing_oauth_data");

  const { data: stateRow, error: stateError } = await supabase
    .from("gmail_oauth_states")
    .select("*")
    .eq("state", state)
    .is("consumed_at", null)
    .maybeSingle();

  if (stateError || !stateRow) return redirectToAdmin("/administracion?gmail=error&message=invalid_state");
  if (new Date(String(stateRow.expires_at)).getTime() < Date.now()) {
    return redirectToAdmin("/administracion?gmail=error&message=expired_state");
  }

  const token = await exchangeCodeForToken(code);
  const expectedSender = requiredEnv("GOOGLE_GMAIL_SENDER").toLowerCase();
  const connectedEmail = parseEmailFromIdToken(token.id_token || "").toLowerCase();

  if (!connectedEmail || connectedEmail !== expectedSender) {
    await recordIntegrationError(supabase, `Cuenta rechazada: ${connectedEmail || "sin email"} no coincide con ${expectedSender}`);
    return redirectToAdmin("/administracion?gmail=error&message=wrong_google_account");
  }

  if (!token.refresh_token) {
    await recordIntegrationError(supabase, "Google no entrego refresh_token. Revoca acceso y vuelve a conectar con prompt consent.");
    return redirectToAdmin("/administracion?gmail=error&message=missing_refresh_token");
  }

  const encryptedRefreshToken = await encryptSecret(token.refresh_token);
  const existing = await getIntegration(supabase, false);
  const payload = {
    connected_email: connectedEmail,
    refresh_token_encrypted: encryptedRefreshToken,
    status: "connected",
    last_connected_at: new Date().toISOString(),
    last_health_check_at: new Date().toISOString(),
    last_error: null,
    updated_by: String(stateRow.user_id),
    created_by: String(stateRow.user_id),
  };

  const request = existing
    ? supabase.from("gmail_integrations").update(payload).eq("id", existing.id)
    : supabase.from("gmail_integrations").insert(payload);
  const { error } = await request;
  if (error) return redirectToAdmin(`/administracion?gmail=error&message=${encodeURIComponent(error.message)}`);

  await supabase.from("gmail_oauth_states").update({ consumed_at: new Date().toISOString() }).eq("state", state);
  const redirectAfter = String(stateRow.redirect_after || "/administracion?gmail=connected");
  return redirectToAdmin(redirectAfter.includes("gmail=") ? redirectAfter : `${redirectAfter}?gmail=connected`);
}

async function handleStatus(supabase: SupabaseClient) {
  const integration = await getIntegration(supabase, false);
  return json({
    connected: integration?.status === "connected",
    connectedEmail: integration?.connected_email ?? null,
    status: integration?.status ?? "disconnected",
    dailyLimit: integration?.daily_limit ?? 50,
    sentToday: integration?.sent_today ?? 0,
    lastConnectedAt: integration?.last_connected_at ?? null,
    lastHealthCheckAt: integration?.last_health_check_at ?? null,
    lastError: integration?.last_error ?? null,
  });
}

async function handleMetrics(supabase: SupabaseClient) {
  const today = new Date().toISOString().slice(0, 10);
  const integration = await getIntegration(supabase, false);

  const [{ count: sentToday }, { count: failed }, { count: activeCampaigns }, { data: lastCampaign }] = await Promise.all([
    supabase.from("email_messages").select("*", { count: "exact", head: true }).eq("status", "sent").gte("created_at", `${today}T00:00:00.000Z`),
    supabase.from("email_messages").select("*", { count: "exact", head: true }).eq("status", "failed").gte("created_at", `${today}T00:00:00.000Z`),
    supabase.from("email_campaigns").select("*", { count: "exact", head: true }).in("status", ["ready", "sending"]),
    supabase.from("email_campaigns").select("name, created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const { data: contactedRows } = await supabase
    .from("email_messages")
    .select("company_id")
    .not("company_id", "is", null)
    .eq("status", "sent");

  return json({
    sentToday: sentToday ?? integration?.sent_today ?? 0,
    dailyLimit: integration?.daily_limit ?? 50,
    activeCampaigns: activeCampaigns ?? 0,
    failedEmails: failed ?? 0,
    companiesContacted: new Set((contactedRows || []).map((row) => row.company_id)).size,
    lastCampaign: lastCampaign?.name ?? null,
  });
}

async function handleDisconnect(supabase: SupabaseClient, user: AuthenticatedUser) {
  const integration = await getIntegration(supabase, false);
  if (!integration) return json({ disconnected: true });

  const { error } = await supabase
    .from("gmail_integrations")
    .update({
      status: "disconnected",
      refresh_token_encrypted: null,
      last_error: null,
      updated_by: user.id,
    })
    .eq("id", integration.id);
  if (error) throw new HttpError(error.message, 400);

  return json({ disconnected: true });
}

async function handleSettings(req: Request, supabase: SupabaseClient, user: AuthenticatedUser) {
  const payload = await req.json().catch(() => ({}));
  const dailyLimit = Number(payload.dailyLimit);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 2000) {
    throw new HttpError("El limite diario debe estar entre 1 y 2000.", 400);
  }

  const integration = await getIntegration(supabase, false);
  const data = {
    daily_limit: dailyLimit,
    updated_by: user.id,
  };

  const request = integration
    ? supabase.from("gmail_integrations").update(data).eq("id", integration.id)
    : supabase.from("gmail_integrations").insert({
        ...data,
        status: "disconnected",
        created_by: user.id,
      });
  const { error } = await request;
  if (error) throw new HttpError(error.message, 400);

  return json({ success: true, dailyLimit });
}

async function handleSendTest(req: Request, supabase: SupabaseClient, user: AuthenticatedUser) {
  const payload = await req.json().catch(() => ({}));
  const toEmail = String(payload.toEmail || "").trim().toLowerCase();
  console.info("[gmail-integration] test-send requested", { userId: user.id, toEmail });

  if (!isEmail(toEmail)) {
    const message = "Ingresa un correo de prueba valido.";
    await logGmailTestAttempt(supabase, { user, toEmail: toEmail || "sin-destinatario", result: "failed", errorMessage: message });
    console.error("[gmail-integration] test-send failed", { userId: user.id, toEmail, error: message });
    throw new HttpError(message, 400);
  }

  const subject = "Prueba CRM LatinChile";
  const bodyText = "Correo de prueba enviado desde CRM LatinChile";

  try {
    const result = await sendTrackedEmail(supabase, {
      user,
      toEmail,
      subject,
      bodyText,
      bodyHtml: `<p>Correo de prueba enviado desde CRM LatinChile</p>`,
      bodyPreview: bodyText.slice(0, 180),
    });

    await logGmailTestAttempt(supabase, {
      user,
      toEmail,
      result: "success",
      gmailMessageId: result.gmailMessageId,
    });
    console.info("[gmail-integration] test-send success", { userId: user.id, toEmail, gmailMessageId: result.gmailMessageId });

    return json({ success: true, message: "Correo de prueba enviado.", gmailMessageId: result.gmailMessageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error enviando correo de prueba.";
    await logGmailTestAttempt(supabase, { user, toEmail, result: "failed", errorMessage: message });
    console.error("[gmail-integration] test-send failed", { userId: user.id, toEmail, error: message });
    throw error;
  }
}

async function handleSendCampaign(req: Request, supabase: SupabaseClient, user: AuthenticatedUser) {
  const payload = await req.json().catch(() => ({}));
  const name = String(payload.name || "").trim();
  const subject = String(payload.subject || "").trim();
  const bodyText = String(payload.bodyText || "").trim();
  const bodyHtml = String(payload.bodyHtml || "").trim();
  const segmentFilters = payload.segmentFilters && typeof payload.segmentFilters === "object" ? payload.segmentFilters : {};
  const recipients = Array.isArray(payload.recipients) ? payload.recipients as CampaignRecipient[] : [];

  if (!name || !subject || !bodyText) throw new HttpError("Faltan nombre, asunto o cuerpo de la campana.", 400);
  if (!recipients.length) throw new HttpError("Selecciona al menos un destinatario.", 400);
  if (recipients.length > 200) throw new HttpError("Por seguridad, el lote maximo local es 200 destinatarios.", 400);

  const { data: campaign, error: campaignError } = await supabase
    .from("email_campaigns")
    .insert({
      name,
      subject,
      body_text: bodyText,
      body_html: bodyHtml || null,
      status: "sending",
      segment_filters: segmentFilters,
      created_by: user.id,
    })
    .select("*")
    .single();
  if (campaignError) throw new HttpError(campaignError.message, 400);

  let sent = 0;
  let failed = 0;
  const log: string[] = [];

  for (const recipient of recipients) {
    const toEmail = String(recipient.toEmail || "").trim().toLowerCase();
    const renderedText = renderVariables(bodyText, recipient.variables || {});
    const renderedHtml = bodyHtml ? renderVariables(bodyHtml, recipient.variables || {}) : "";

    const { data: recipientRow } = await supabase
      .from("email_campaign_recipients")
      .insert({
        campaign_id: campaign.id,
        company_id: recipient.companyId || null,
        contact_email: toEmail,
        status: "pending",
      })
      .select("*")
      .single();

    if (!isEmail(toEmail)) {
      failed += 1;
      const message = "Correo invalido";
      log.push(`${toEmail || "sin correo"}: ${message}`);
      await updateRecipientFailure(supabase, recipientRow?.id, message);
      continue;
    }

    try {
      const result = await sendTrackedEmail(supabase, {
        user,
        toEmail,
        subject: renderVariables(subject, recipient.variables || {}),
        bodyText: renderedText,
        bodyHtml: renderedHtml,
        bodyPreview: renderedText.slice(0, 180),
        companyId: recipient.companyId,
        campaignId: campaign.id,
      });

      sent += 1;
      log.push(`${toEmail}: enviado`);
      await supabase
        .from("email_campaign_recipients")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          gmail_message_id: result.gmailMessageId,
        })
        .eq("id", recipientRow.id);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "Error desconocido";
      log.push(`${toEmail}: ${message}`);
      await updateRecipientFailure(supabase, recipientRow?.id, message);
    }
  }

  await supabase
    .from("email_campaigns")
    .update({ status: failed && !sent ? "failed" : "sent" })
    .eq("id", campaign.id);

  return json({ success: failed === 0, campaignId: campaign.id, sent, failed, log });
}

async function sendTrackedEmail(
  supabase: SupabaseClient,
  input: {
    user: AuthenticatedUser;
    toEmail: string;
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    bodyPreview: string;
    companyId?: string;
    campaignId?: string;
  },
) {
  const integration = await prepareIntegrationForSend(supabase);
  const refreshToken = await decryptSecret(integration.refresh_token_encrypted || "");
  const accessToken = await refreshAccessToken(refreshToken);
  const sender = requiredEnv("GOOGLE_GMAIL_SENDER");

  const { data: messageRow } = await supabase
    .from("email_messages")
    .insert({
      company_id: input.companyId || null,
      campaign_id: input.campaignId || null,
      to_email: input.toEmail,
      subject: input.subject,
      body_preview: input.bodyPreview,
      status: "pending",
      created_by: input.user.id,
    })
    .select("*")
    .single();

  try {
    const gmailMessageId = await sendGmailMessage({
      accessToken,
      fromEmail: sender,
      toEmail: input.toEmail,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
    });

    await supabase
      .from("email_messages")
      .update({ status: "sent", sent_at: new Date().toISOString(), gmail_message_id: gmailMessageId })
      .eq("id", messageRow.id);

    await incrementSentToday(supabase, integration);

    if (input.companyId) {
      await supabase.from("interactions").insert({
        company_id: input.companyId,
        type: "correo",
        owner_id: input.user.id,
        description: `Email enviado por Gmail API\nAsunto: ${input.subject}\nPara: ${input.toEmail}`,
        result: "Email enviado",
        next_action: "Monitorear respuesta",
      });
    }

    return { gmailMessageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error enviando Gmail";
    if (messageRow?.id) {
      await supabase.from("email_messages").update({ status: "failed", error_message: message }).eq("id", messageRow.id);
    }
    await recordIntegrationError(supabase, message);
    throw error;
  }
}

async function prepareIntegrationForSend(supabase: SupabaseClient) {
  const integration = await getIntegration(supabase, true);
  if (!integration.refresh_token_encrypted) throw new HttpError("Gmail no está conectado. Conecta la cuenta antes de enviar prueba.", 400);

  if (integration.sent_today_date !== new Date().toISOString().slice(0, 10)) {
    await supabase
      .from("gmail_integrations")
      .update({ sent_today: 0, sent_today_date: new Date().toISOString().slice(0, 10) })
      .eq("id", integration.id);
    integration.sent_today = 0;
  }

  if (integration.sent_today >= integration.daily_limit) {
    throw new HttpError("Se alcanzo el limite diario interno de Gmail.", 429);
  }

  return integration;
}

async function exchangeCodeForToken(code: string) {
  const body = new URLSearchParams({
    code,
    client_id: requiredEnv("GOOGLE_CLIENT_ID"),
    client_secret: requiredEnv("GOOGLE_CLIENT_SECRET"),
    redirect_uri: requiredEnv("GOOGLE_REDIRECT_URI"),
    grant_type: "authorization_code",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new HttpError(data.error_description || data.error || "Google token exchange failed", 400);
  return data as { access_token: string; refresh_token?: string; id_token?: string };
}

async function refreshAccessToken(refreshToken: string) {
  const body = new URLSearchParams({
    client_id: requiredEnv("GOOGLE_CLIENT_ID"),
    client_secret: requiredEnv("GOOGLE_CLIENT_SECRET"),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new HttpError(data.error_description || data.error || "Could not refresh Gmail token", 400);
  return String(data.access_token);
}

async function sendGmailMessage(input: {
  accessToken: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
}) {
  const raw = buildMimeMessage(input);
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  const data = await res.json();
  if (!res.ok) throw new HttpError(data.error?.message || "Gmail API send failed", 400);
  return String(data.id || "");
}

function buildMimeMessage(input: { fromEmail: string; toEmail: string; subject: string; bodyText: string; bodyHtml?: string }) {
  const boundary = `crm_latinchile_${crypto.randomUUID()}`;
  const headers = [
    `From: LatinChile CRM <${input.fromEmail}>`,
    `To: ${input.toEmail}`,
    `Subject: ${encodeMimeHeader(input.subject)}`,
    "MIME-Version: 1.0",
  ];

  const body = input.bodyHtml
    ? [
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        input.bodyText,
        `--${boundary}`,
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        input.bodyHtml,
        `--${boundary}--`,
      ]
    : [
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        input.bodyText,
      ];

  return base64UrlEncode(`${headers.join("\r\n")}\r\n${body.join("\r\n")}`);
}

async function getIntegration(supabase: SupabaseClient, requireConnected: boolean): Promise<GmailIntegration> {
  const { data, error } = await supabase
    .from("gmail_integrations")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new HttpError(error.message, 500);
  if (!data && requireConnected) throw new HttpError("Gmail no esta conectado.", 400);
  if (data && requireConnected && data.status !== "connected") throw new HttpError("Gmail esta desconectado.", 400);
  return data as GmailIntegration;
}

async function requireAdmin(req: Request, supabase: SupabaseClient): Promise<AuthenticatedUser> {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError("Sesion requerida.", 401);

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) throw new HttpError("Sesion invalida.", 401);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", authData.user.id)
    .maybeSingle();

  const role = String(profile?.role || authData.user.user_metadata?.role || "");
  if (profileError || role !== "administrador") throw new HttpError("Solo administradores pueden usar Gmail.", 403);

  return {
    id: authData.user.id,
    email: authData.user.email || "",
    role,
  };
}

async function encryptSecret(secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getCryptoKey();
  const encoded = new TextEncoder().encode(secret);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return `${base64UrlEncodeBytes(iv)}.${base64UrlEncodeBytes(new Uint8Array(encrypted))}`;
}

async function decryptSecret(payload: string) {
  const [ivPart, cipherPart] = payload.split(".");
  if (!ivPart || !cipherPart) throw new HttpError("Token Gmail corrupto.", 500);

  const key = await getCryptoKey();
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecodeBytes(ivPart) },
    key,
    base64UrlDecodeBytes(cipherPart),
  );
  return new TextDecoder().decode(decrypted);
}

async function getCryptoKey() {
  const secret = requiredEnv("GMAIL_TOKEN_ENCRYPTION_KEY");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function parseEmailFromIdToken(idToken: string) {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return "";
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(payload)));
    return String(decoded.email || "");
  } catch {
    return "";
  }
}

async function incrementSentToday(supabase: SupabaseClient, integration: GmailIntegration) {
  await supabase
    .from("gmail_integrations")
    .update({
      sent_today: integration.sent_today + 1,
      sent_today_date: new Date().toISOString().slice(0, 10),
      last_health_check_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", integration.id);
}

async function recordIntegrationError(supabase: SupabaseClient, lastError: string) {
  const integration = await getIntegration(supabase, false).catch(() => null);
  if (!integration) {
    await supabase.from("gmail_integrations").insert({
      status: "error",
      last_error: lastError,
      daily_limit: 50,
    });
    return;
  }

  await supabase.from("gmail_integrations").update({ status: "error", last_error: lastError }).eq("id", integration.id);
}

async function updateRecipientFailure(supabase: SupabaseClient, recipientId: string | undefined, errorMessage: string) {
  if (!recipientId) return;
  await supabase
    .from("email_campaign_recipients")
    .update({ status: "failed", error_message: errorMessage })
    .eq("id", recipientId);
}

async function logGmailTestAttempt(
  supabase: SupabaseClient,
  input: {
    user: AuthenticatedUser;
    toEmail: string;
    result: "success" | "failed";
    gmailMessageId?: string;
    errorMessage?: string;
  },
) {
  const { error } = await supabase.from("gmail_test_logs").insert({
    user_id: input.user.id,
    to_email: input.toEmail,
    result: input.result,
    gmail_message_id: input.gmailMessageId || null,
    error_message: input.errorMessage || null,
  });

  if (error) {
    console.error("[gmail-integration] could not write gmail_test_logs", {
      userId: input.user.id,
      toEmail: input.toEmail,
      result: input.result,
      error: error.message,
    });
  }
}

function renderVariables(template: string, variables: Record<string, string>) {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const value = variables[key.trim()];
    return value === undefined ? "" : value;
  });
}

function getRoute(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "status";
}

function redirectToAdmin(path: string) {
  const appUrl = Deno.env.get("CRM_APP_URL") || "http://localhost:5173";
  const target = path.startsWith("http") ? path : `${appUrl}${path.startsWith("/") ? path : `/${path}`}`;
  return Response.redirect(target, 302);
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(`Missing ${name}`, 500);
  return value;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function base64UrlEncode(value: string) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeMimeHeader(value: string) {
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(value)))}?=`;
}

class HttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
