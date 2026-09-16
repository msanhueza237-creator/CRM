import { object, type Row } from "./contracts.ts";

export function redactSecrets(value: string): string {
  return value
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, "[credencial omitida]")
    .replace(/Bearer\s+[a-zA-Z0-9._~-]+/gi, "Bearer [omitido]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[token omitido]",
    )
    .replace(
      /((?:api[_ -]?key|password|contrasena|contrase\u00f1a|access_token|refresh_token|client_secret)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[omitido]",
    );
}

// Data remain untrusted even after projection. Never expose credentials in a tool result.
export function safeData(value: unknown, depth = 0): unknown {
  if (depth > 14) return null;
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => safeData(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(object(value))
        .filter(
          ([key]) =>
            !/(password|secret|api.?key|access.?token|refresh.?token|authorization|cookie)/i.test(
              key,
            ),
        )
        .map(([key, child]) => [key, safeData(child, depth + 1)]),
    );
  return value;
}

export function sessionExpires(
  metadata: Row,
  createdAt: unknown,
  days: number,
): string {
  const configured = Date.parse(String(metadata.expiresAt || ""));
  const created = Date.parse(String(createdAt || ""));
  return new Date(
    Number.isFinite(configured)
      ? configured
      : (Number.isFinite(created) ? created : 0) + days * 86400000,
  ).toISOString();
}
