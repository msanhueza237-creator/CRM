import { publicWebsite } from "./prospecting-assistance.ts";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

export function publicResearchContext(value: unknown, hintValue: unknown) {
  const row = object(value), hint = object(hintValue);
  const source = publicWebsite(row.source_url), known = publicWebsite(hint.website);
  if (!source || !known || new URL(source).hostname.replace(/^www\./, "") !== new URL(known).hostname.replace(/^www\./, "")) return null;
  const result: Row = { source_url: source };
  for (const [key, limit] of Object.entries({ name: 300, activity: 1200, address: 500, comuna_name: 120 })) {
    if (typeof row[key] === "string" && row[key].trim() && row[key].length <= limit) result[key] = row[key].trim();
  }
  return result.name && result.activity ? result : null;
}

// The caller scopes these expiring records to the claimed job's entity and run.
// This envelope is a matching aid; it must never become permanent official data.
export function retainedDiscoveryHint(candidateValue: unknown, records: unknown, now = Date.now()) {
  const candidate = object(candidateValue);
  const fields = new Map<string, Row>();
  for (const row of (Array.isArray(records) ? records : []).map(object)) {
    const observed = Date.parse(String(row.observed_at ?? ""));
    const expires = Date.parse(String(row.retention_until ?? ""));
    if (row.provider !== "google_places" || !Number.isFinite(observed) || observed > now
      || !Number.isFinite(expires) || expires <= now || typeof row.field_value !== "string"
      || !row.field_value.trim() || row.field_value.length > 4000) continue;
    const field = String(row.field_name ?? "");
    const previous = fields.get(field);
    if (!previous || observed > Date.parse(String(previous.observed_at))) fields.set(field, row);
  }
  const value = (field: string) => fields.get(field)?.field_value;
  if (typeof candidate.candidate_id !== "string" || !value("name") || !publicWebsite(value("website"))) return null;
  const lengths: Record<string, number> = { name: 300, website: 2048, phone: 50,
    "location.address": 500, "location.comuna_name": 120, "location.region_name": 120 };
  if (Object.entries(lengths).some(([field, max]) => String(value(field) ?? "").length > max)) return null;
  const selected = [...fields.entries()].filter(([field]) => field in lengths || ["location.region_code", "location.comuna_code"].includes(field));
  return { candidate_id: candidate.candidate_id, name: value("name"), website: value("website"), phone: value("phone"),
    location: { country_code: "CL", address: value("location.address"), comuna_name: value("location.comuna_name"),
      region_name: value("location.region_name"), comuna_code: value("location.comuna_code"), region_code: value("location.region_code") },
    evidence: selected.map(([field, row]) => ({ provider: "google_places", field, value: row.field_value,
      source_url: row.source_url, provider_record_id: row.provider_record_id,
      observed_at: row.observed_at, retention_until: row.retention_until })) };
}
