export class IntegrationError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function limitedJson(input: Request | Response, maxBytes = 4096) {
  const reader = input.body?.getReader();
  if (!reader) throw new IntegrationError(400, "INVALID_BODY", "Solicitud vacía.");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new IntegrationError(413, "BODY_TOO_LARGE", "Solicitud demasiado grande.");
      parts.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new IntegrationError(400, "INVALID_BODY", "El formato de la solicitud no es válido."); }
}

export function validateApiKey(input: unknown) {
  if (typeof input !== "string") throw new IntegrationError(400, "INVALID_KEY", "Ingresa una clave API válida.");
  const key = input.trim();
  if (key.length < 16 || key.length > 512 || /[^\x21-\x7e]/.test(key)) {
    throw new IntegrationError(400, "INVALID_KEY", "La clave API tiene un formato inválido.");
  }
  return key;
}

async function encryptionKey(secret: string) {
  if (new TextEncoder().encode(secret).length < 32) {
    throw new IntegrationError(503, "SETUP_REQUIRED", "Falta habilitar el almacenamiento seguro en el servidor.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const context = new TextEncoder().encode("prospecting:deepseek:v1");
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (text: string) => Uint8Array.from(atob(text), character => character.charCodeAt(0));

export async function encryptApiKey(value: string, secret: string) {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: context }, key, new TextEncoder().encode(value));
  return `v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}

export async function decryptApiKey(value: string, secret: string) {
  const key = await encryptionKey(secret);
  try {
    const [version, nonce, ciphertext, extra] = value.split(".");
    if (version !== "v1" || extra) throw new Error();
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(nonce), additionalData: context }, key, decode(ciphertext));
    return new TextDecoder().decode(decrypted);
  } catch { throw new IntegrationError(503, "KEY_UNREADABLE", "No se pudo abrir la clave guardada. Revisa la configuración segura del servidor."); }
}

export async function verifyDeepSeekKey(key: string, send: typeof fetch = fetch) {
  let response: Response;
  try {
    response = await send("https://api.deepseek.com/models", {
      method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
  } catch { throw new IntegrationError(502, "PROVIDER_UNAVAILABLE", "No se pudo contactar con DeepSeek. Intenta nuevamente."); }
  if (!response.ok) await response.body?.cancel();
  if (response.status === 401 || response.status === 403) throw new IntegrationError(422, "KEY_REJECTED", "DeepSeek rechazó la clave. Revísala o genera una nueva.");
  if (response.status === 402) throw new IntegrationError(422, "BALANCE_REQUIRED", "DeepSeek informa saldo insuficiente en tu cuenta.");
  if (response.status === 429) throw new IntegrationError(429, "RATE_LIMITED", "DeepSeek limitó temporalmente las solicitudes. Espera antes de reintentar.");
  if (!response.ok) throw new IntegrationError(502, "PROVIDER_UNAVAILABLE", "DeepSeek no pudo verificar la conexión.");
  let data;
  try { data = await limitedJson(response, 32768); }
  catch { throw new IntegrationError(502, "INVALID_PROVIDER_RESPONSE", "DeepSeek devolvió una respuesta no válida."); }
  const models = Array.isArray(data?.data) ? [...new Set<string>(data.data.map((item: { id?: unknown }) => item?.id)
    .filter((id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9._:/+-]{1,128}$/.test(id)))] : [];
  if (!models.length) throw new IntegrationError(502, "INVALID_PROVIDER_RESPONSE", "DeepSeek no entregó modelos disponibles para esta clave.");
  return models.slice(0, 50);
}
