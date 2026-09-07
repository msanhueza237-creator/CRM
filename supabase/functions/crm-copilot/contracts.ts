export type Row = Record<string, unknown>;
export type CopilotRole =
  "administrador" | "finanzas" | "vendedor" | "visualizador";
export type Domain =
  | "products"
  | "customers"
  | "sales"
  | "finance"
  | "foreign_trade"
  | "content"
  | "campaigns"
  | "agents";
export type ResultStatus =
  | "ok"
  | "empty"
  | "partial"
  | "unavailable"
  | "forbidden"
  | "needs_clarification";
export interface Evidence {
  label: string;
  path: string;
  entityType: string;
  entityId?: string;
  observedAt?: string | null;
}
export interface ResultTable {
  title: string;
  columns: Array<{ key: string; label: string }>;
  rows: Row[];
}
export interface ReadResult {
  toolName: string;
  domain: Domain;
  status: ResultStatus;
  summary: string;
  data: unknown;
  evidence: Evidence[];
  warnings: string[];
  coverage: {
    complete: boolean;
    totalMatched: number | null;
    returned: number;
    nextOffset?: number;
    from?: string;
    to?: string;
  };
  freshness: { fetchedAt: string; sourceObservedAt: string | null };
  table?: ResultTable;
  continuation?: { toolName: string; args: Row };
}
export interface ToolDefinition {
  name: string;
  description: string;
  domain: Domain;
  version: number;
  parameters: Row;
  execute: (args: Row) => Promise<ReadResult>;
}
export interface CopilotActor {
  id: string;
  role: CopilotRole;
  accessToken: string;
}
export interface RestConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}
export class CopilotDataError extends Error {
  constructor(
    message: string,
    public code = "SOURCE_UNAVAILABLE",
  ) {
    super(message);
  }
}

export const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
export const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(object) : [];
export const normalized = (value: unknown) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
export const numeric = (value: unknown): number | null =>
  (typeof value !== "number" && typeof value !== "string") ||
  String(value).trim() === "" ||
  !Number.isFinite(Number(value))
    ? null
    : Number(value);
export const observedAt = (values: Row[]) =>
  values
    .map((row) =>
      String(row.updated_at || row.observed_at || row.last_synced_at || ""),
    )
    .filter(Boolean)
    .sort()
    .at(-1) || null;
export function matches(query: unknown, ...values: unknown[]) {
  const text = normalized(values.join(" "));
  const words = normalized(query).split(/\s+/).filter(Boolean);
  return words.every((word) => {
    const compact = word.replace(/[^a-z0-9]/g, "");
    return (
      text.includes(word) ||
      Boolean(compact && text.replace(/[^a-z0-9]/g, "").includes(compact))
    );
  });
}

// Monetary aggregates use fixed four-decimal integers; missing amounts stay missing.
export function decimalSum(values: unknown[]): string | null {
  let total = 0n;
  for (const value of values) {
    if (
      value === null ||
      value === undefined ||
      !/^-?\d+(?:\.\d{1,4})?$/.test(String(value))
    )
      return null;
    const text = String(value);
    const [whole, fraction = ""] = text.replace("-", "").split(".");
    total +=
      (BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"))) *
      (text.startsWith("-") ? -1n : 1n);
  }
  const absolute = total < 0n ? -total : total;
  return `${total < 0n ? "-" : ""}${absolute / 10000n}.${String(absolute % 10000n).padStart(4, "0")}`;
}

export function readResult(
  toolName: string,
  domain: Domain,
  summary: string,
  data: unknown,
  evidence: Evidence[],
  options: Partial<ReadResult> = {},
): ReadResult {
  return {
    toolName,
    domain,
    status: "ok",
    summary,
    data,
    evidence,
    warnings: [],
    coverage: { complete: true, totalMatched: null, returned: 0 },
    freshness: {
      fetchedAt: new Date().toISOString(),
      sourceObservedAt: evidence[0]?.observedAt || null,
    },
    ...options,
  };
}

export function tableResult(
  toolName: string,
  domain: Domain,
  title: string,
  data: Row[],
  columns: ResultTable["columns"],
  path: string,
  args: Row = {},
  warnings: string[] = [],
): ReadResult {
  const offset = Number(args.offset || 0);
  const limit = Number(args.limit || 25);
  const page = data.slice(offset, offset + limit);
  const sourceObservedAt = observedAt(data);
  return readResult(
    toolName,
    domain,
    `${title}: ${data.length} coincidencias.`,
    { records: page },
    [{ label: title, entityType: domain, path, observedAt: sourceObservedAt }],
    {
      status: data.length ? "ok" : "empty",
      warnings,
      coverage: {
        complete: true,
        totalMatched: data.length,
        returned: page.length,
        ...(offset + page.length < data.length
          ? { nextOffset: offset + page.length }
          : {}),
      },
      freshness: { fetchedAt: new Date().toISOString(), sourceObservedAt },
      table: { title, columns, rows: page },
    },
  );
}
