import type { ProspectCandidate } from "../../types/crm";

export type CandidateQuality = "contactable" | "pending" | "outside";
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const text = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function officialIdentity(value: string) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return "";
    const host = url.hostname.replace(/^www\./, "");
    if (/^(instagram|facebook)\.com$/.test(host)) {
      const profile = url.pathname.split("/").filter(Boolean)[0];
      return profile ? host + "/" + profile : "";
    }
    return host;
  } catch { return ""; }
}

function sameOfficialSite(candidate: ProspectCandidate, url: string) {
  const identity = officialIdentity(candidate.website);
  return Boolean(identity && identity === officialIdentity(url));
}

export function hasVerifiedContact(candidate: ProspectCandidate, field: "phone" | "email") {
  const value = candidate[field];
  const valid = field === "phone" ? /^\+56[2-9]\d{8}$/.test(value.replace(/[\s()-]/g, "")) : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  return valid && candidate.evidence.some(e => e.field === field && e.source === "official_website" && sameOfficialSite(candidate, e.url)
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
  const directory = /\b(?:somos (?:un |el )?directorio|es (?:un |el )directorio|directorio (?:empresarial|de empresas)|bolsa de empleo)\b/.test(text(candidate.businessLine));
  if (foreignPhone || foreignSite || directory || candidate.reviewFlags.some(flag => ["foreign_country", "foreign_phone", "foreign_contact", "outside_target_types", "directory_or_non_business", "official_identity_conflict"].includes(flag))) return "outside";
  // Historical validation did not verify that all fields belonged to one business.
  if (candidate.discoveryStatus && candidate.enrichmentSummary?.validation_version !== "public-web-v4") return "pending";
  const contact = hasVerifiedContact(candidate, "phone") || hasVerifiedContact(candidate, "email");
  const activity = candidate.businessLine.trim().length >= 20
    && /\b(?:climatizacion|refrigeracion|aire acondicionado|hvac)\b/.test(text(candidate.businessLine))
    && candidate.evidence.some(e => ["description", "business_line"].includes(e.field) && e.source === "official_website" && sameOfficialSite(candidate, e.url) && normalize(e.value) === normalize(candidate.businessLine));
  const location = candidate.locations.some(l => l.regionCode && l.comunaCode && l.address);
  const identity = candidate.evidence.some(e => e.field === "name" && e.source === "official_website" && sameOfficialSite(candidate, e.url) && normalize(e.value) === normalize(candidate.name));
  return candidate.importEligible && contact && activity && location && identity
    && (!candidate.discoveryStatus || candidate.discoveryStatus === "validated") ? "contactable" : "pending";
}

export const qualityLabels: Record<CandidateQuality, string> = {
  contactable: "Contactable", pending: "Por verificar", outside: "Fuera de alcance",
};

export function candidateReviewBucket(candidate: ProspectCandidate) {
  if (["approved", "linked"].includes(candidate.reviewStatus)) return "reviewed";
  if (candidate.reviewStatus === "rejected") return "rejected";
  return candidateQuality(candidate);
}

export function candidateCounts(candidates: ProspectCandidate[]) {
  const counts = { total: candidates.length, contactable: 0, pending: 0, outside: 0, reviewed: 0, rejected: 0 };
  for (const candidate of candidates) counts[candidateReviewBucket(candidate)]++;
  return counts;
}
