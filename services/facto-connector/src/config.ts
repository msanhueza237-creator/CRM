export interface FactoConnectorConfig {
  workerId: string;
  crmAgentUrl: string;
  crmAgentApiKey: string;
  api: {
    baseUrl: string;
    clientId: string;
    clientSecret: string;
    resourceOwnerName: string;
    resourceOwnerPassword: string;
    issuedFlag: string;
    currencyMap: Record<string, string>;
    timeoutMs: number;
    maxRetries: number;
    retryBaseMs: number;
    maxRetryDelayMs: number;
  };
  browser: {
    baseUrl: string;
    loginUrl: string;
    unpaidUrl: string | null;
    username: string;
    password: string;
    headless: boolean;
    channel: "chrome" | "chrome-beta" | "msedge" | null;
    timeoutMs: number;
    maxPages: number;
    evidenceDir: string;
  };
}

export function loadFactoConnectorConfig(env: NodeJS.ProcessEnv = process.env): FactoConnectorConfig {
  const crmAgentUrl = secureUrl(required(env, "CRM_AGENT_URL"), "CRM_AGENT_URL", true);
  const apiBaseUrl = secureUrl(env.FACTO_API_BASE_URL || "https://apifacto.com/v1", "FACTO_API_BASE_URL");
  const webBaseUrl = secureUrl(required(env, "FACTO_WEB_BASE_URL"), "FACTO_WEB_BASE_URL");
  const loginUrl = secureUrl(env.FACTO_WEB_LOGIN_URL || webBaseUrl, "FACTO_WEB_LOGIN_URL");
  const unpaidUrl = env.FACTO_WEB_UNPAID_URL?.trim()
    ? secureUrl(env.FACTO_WEB_UNPAID_URL, "FACTO_WEB_UNPAID_URL")
    : null;
  return {
    workerId: sanitizeWorkerId(env.FACTO_WORKER_ID || `facto-receivables-${process.pid}`),
    crmAgentUrl: crmAgentUrl.replace(/\/+$/, ""),
    crmAgentApiKey: required(env, "CRM_AGENT_API_KEY"),
    api: loadFactoApiConfig(env, apiBaseUrl),
    browser: {
      baseUrl: webBaseUrl.replace(/\/+$/, ""),
      loginUrl,
      unpaidUrl,
      username: required(env, "FACTO_WEB_USERNAME"),
      password: required(env, "FACTO_WEB_PASSWORD"),
      headless: env.FACTO_WEB_HEADLESS !== "false",
      channel: browserChannel(env.FACTO_BROWSER_CHANNEL),
      timeoutMs: boundedInteger(env.FACTO_BROWSER_TIMEOUT_MS, 5_000, 120_000, 30_000),
      maxPages: boundedInteger(env.FACTO_BROWSER_MAX_PAGES, 1, 500, 100),
      evidenceDir: env.FACTO_EVIDENCE_DIR?.trim() || ".facto-evidence",
    },
  };
}

export function loadFactoApiConfig(
  env: NodeJS.ProcessEnv = process.env,
  validatedBaseUrl?: string,
): FactoConnectorConfig["api"] {
  const baseUrl = validatedBaseUrl
    || secureUrl(env.FACTO_API_BASE_URL || "https://apifacto.com/v1", "FACTO_API_BASE_URL");
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    clientId: required(env, "FACTO_API_CLIENT_ID"),
    clientSecret: required(env, "FACTO_API_CLIENT_SECRET"),
    resourceOwnerName: required(env, "FACTO_API_RESOURCE_OWNER_NAME"),
    resourceOwnerPassword: required(env, "FACTO_API_RESOURCE_OWNER_PASSWORD"),
    issuedFlag: env.FACTO_API_ISSUED_FLAG?.trim() || "1",
    currencyMap: currencyMap(env.FACTO_CURRENCY_MAP_JSON),
    timeoutMs: boundedInteger(env.FACTO_API_TIMEOUT_MS, 5_000, 120_000, 30_000),
    maxRetries: boundedInteger(env.FACTO_API_MAX_RETRIES, 0, 5, 2),
    retryBaseMs: boundedInteger(env.FACTO_API_RETRY_BASE_MS, 100, 30_000, 1_000),
    maxRetryDelayMs: boundedInteger(env.FACTO_API_MAX_RETRY_DELAY_MS, 1_000, 120_000, 60_000),
  };
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Falta configurar la variable segura ${name}.`);
  return value;
}

function secureUrl(value: string, name: string, allowLocalHttp = false) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} no contiene una URL válida.`);
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowLocalHttp && local)) {
    throw new Error(`${name} debe utilizar HTTPS${allowLocalHttp ? " fuera del equipo local" : ""}.`);
  }
  url.username = "";
  url.password = "";
  return url.toString();
}

function boundedInteger(raw: string | undefined, minimum: number, maximum: number, fallback: number) {
  const value = Number(raw);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function currencyMap(raw: string | undefined) {
  const officialCurrencies = { "5": "USD", "38": "EUR", "39": "CLP" };
  if (!raw?.trim()) return officialCurrencies;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed)
      .filter(([, value]) => typeof value === "string" && /^[A-Z]{3}$/.test(value))
      .map(([key, value]) => [key, String(value)] as const);
    return { ...officialCurrencies, ...Object.fromEntries(entries) };
  } catch {
    throw new Error("FACTO_CURRENCY_MAP_JSON debe ser un objeto JSON válido.");
  }
}

function sanitizeWorkerId(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 120) || "facto-receivables-worker";
}

function browserChannel(value: string | undefined): FactoConnectorConfig["browser"]["channel"] {
  const channel = value?.trim().toLowerCase() || "";
  if (!channel) return null;
  if (["chrome", "chrome-beta", "msedge"].includes(channel)) {
    return channel as FactoConnectorConfig["browser"]["channel"];
  }
  throw new Error("FACTO_BROWSER_CHANNEL debe ser chrome, chrome-beta o msedge.");
}
