export type InstagramContainerState = {
  state: "ready" | "pending" | "failed";
  statusCode: string;
  message: string;
};

export const OFFICIAL_WEBSITE_URL = "https://climactiva.cl";
export const OFFICIAL_BRAND_HASHTAG = "ClimaActiva";

export function ensureOfficialWebsiteCta(value: string) {
  const cta = value.trim();
  if (!cta) return `Conoce mas en ${OFFICIAL_WEBSITE_URL}`;

  if (/(?:https?:\/\/)?(?:www\.)?climactiva\.cl(?:\/\S*)?/i.test(cta)) {
    return cta.replace(
      /(?:https?:\/\/)?(?:www\.)?climactiva\.cl(?:\/\S*)?/i,
      (url) => url.startsWith("http") ? url : `${OFFICIAL_WEBSITE_URL}${url.replace(/^(?:www\.)?climactiva\.cl/i, "")}`,
    );
  }

  return `${cta}\nVisita ${OFFICIAL_WEBSITE_URL}`;
}

export function ensureBrandHashtag(hashtags: string[]) {
  const seen = new Set<string>();
  const normalized = hashtags
    .map((tag) => tag.trim().replace(/^#+/, ""))
    .filter(Boolean)
    .filter((tag) => {
      const key = tag.toLocaleLowerCase("es");
      if (key === "climactiva" || key === "climactiva.cl") return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 29);

  return [...normalized, OFFICIAL_BRAND_HASHTAG];
}

export function buildSocialCaption(input: { body: string; cta?: string | null; hashtags: string[] }) {
  const hashtagText = ensureBrandHashtag(input.hashtags)
    .map((tag) => `#${tag}`)
    .join(" ");
  return [input.body.trim(), ensureOfficialWebsiteCta(input.cta || ""), hashtagText]
    .filter(Boolean)
    .join("\n\n");
}

export function classifyInstagramContainerStatus(raw: Record<string, unknown>): InstagramContainerState {
  const statusCode = String(raw.status_code || "").trim().toUpperCase();
  const message = String(raw.status || "").trim();
  if (statusCode === "FINISHED") return { state: "ready", statusCode, message };
  if (statusCode === "ERROR" || statusCode === "EXPIRED") {
    return { state: "failed", statusCode, message };
  }
  return { state: "pending", statusCode: statusCode || "IN_PROGRESS", message };
}

export function isInstagramMediaNotReady(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /media id is not available|media is not ready|media.*not available/i.test(message);
}

export function isFacebookPublishPermissionMissing(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /pages_manage_posts/i.test(message);
}
