import type { ProspectCandidate } from "../../types/crm";

export type CandidateQuality = "contactable" | "pending" | "outside";
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function hasVerifiedContact(candidate: ProspectCandidate, field: "phone" | "email") {
  const value = candidate[field];
  const valid = field === "phone" ? /^\+56[2-9]\d{8}$/.test(value.replace(/[\s()-]/g, "")) : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  return valid && candidate.evidence.some(e => e.field === field && e.source === "official_website"
    && (field === "email" ? e.value.trim().toLowerCase() === value.trim().toLowerCase() : normalize(e.value) === normalize(value)));
}

export function candidateQuality(candidate: ProspectCandidate): CandidateQuality {
  const foreignPhone = candidate.phone.startsWith("+") && !candidate.phone.startsWith("+56");
  let foreignSite = false;
  for (const value of [candidate.website, candidate.discoveryUrl, candidate.email ? `https://${candidate.email.split("@")[1]}` : ""]) {
    try {
      const tld = new URL(value || "").hostname.split(".").slice(-1)[0] || "";
      foreignSite ||= tld.length === 2 && !["cl", "io", "ai", "co", "tv"].includes(tld);
    } catch { /* Missing URLs remain unverified. */ }
  }
  if (foreignPhone || foreignSite || candidate.reviewFlags.some(flag => ["foreign_country", "foreign_phone", "foreign_contact", "outside_target_types", "directory_or_non_business", "official_identity_conflict"].includes(flag))) return "outside";
  const contact = hasVerifiedContact(candidate, "phone") || hasVerifiedContact(candidate, "email");
  const activity = candidate.businessLine.trim().length >= 20 && candidate.evidence.some(e => ["description", "business_line"].includes(e.field) && e.source === "official_website" && normalize(e.value) === normalize(candidate.businessLine));
  const location = candidate.locations.some(l => l.regionCode && l.comunaCode && l.address);
  const identity = candidate.evidence.some(e => e.field === "name" && ["official_website", "google_places"].includes(e.source) && normalize(e.value) === normalize(candidate.name));
  return candidate.importEligible && contact && activity && location && identity
    && (!candidate.discoveryStatus || candidate.discoveryStatus === "validated") ? "contactable" : "pending";
}

export const qualityLabels: Record<CandidateQuality, string> = {
  contactable: "Contactable", pending: "Por verificar", outside: "Fuera de alcance",
};
