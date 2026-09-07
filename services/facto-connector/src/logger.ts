import type { JsonObject, JsonValue } from "./types.ts";

const sensitiveKey = /pass(word)?|secret|token|cookie|authorization|api[_-]?key|session|credential/i;
const bearerValue = /bearer\s+[a-z0-9._~+/-]+=*/gi;

export class SafeLogger {
  constructor(private readonly context: JsonObject = {}) {}

  child(context: JsonObject) {
    return new SafeLogger({ ...this.context, ...context });
  }

  info(message: string, data: JsonObject = {}) {
    this.write("info", message, data);
  }

  warn(message: string, data: JsonObject = {}) {
    this.write("warning", message, data);
  }

  error(message: string, error: unknown, data: JsonObject = {}) {
    const safeError: JsonObject = error instanceof Error
      ? { name: error.name, message: redactString(error.message) }
      : { message: redactString(String(error)) };
    this.write("error", message, { ...data, error: safeError });
  }

  private write(level: "info" | "warning" | "error", message: string, data: JsonObject) {
    const payload = redact({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.context,
      ...data,
    });
    const output = JSON.stringify(payload);
    if (level === "error") console.error(output);
    else if (level === "warning") console.warn(output);
    else console.info(output);
  }
}

export function redact(value: JsonValue, key = ""): JsonValue {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redact(childValue, childKey),
    ]));
  }
  return typeof value === "string" ? redactString(value) : value;
}

function redactString(value: string) {
  const withoutBearer = value.replace(bearerValue, "Bearer [REDACTED]");
  try {
    const url = new URL(withoutBearer);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return withoutBearer.slice(0, 2_000);
  }
}
