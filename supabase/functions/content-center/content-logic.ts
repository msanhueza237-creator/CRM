export type ContentLogicRecord = Record<string, unknown>;

export function selectRotatedProduct(
  products: ContentLogicRecord[],
  publications: ContentLogicRecord[],
  channels: ContentLogicRecord[],
  rules: Map<string, ContentLogicRecord>,
  now = Date.now(),
) {
  const latestProductId = publications.find((item) => ["published", "scheduled"].includes(String(item.status)))?.product_id;
  const latestCategory = products.find((item) => item.id === latestProductId)?.category;
  const scored = products.map((product) => {
    const related = publications.filter((item) => item.product_id === product.id);
    const lastTime = related.reduce(
      (latest, item) => Math.max(latest, Date.parse(String(item.published_at || item.scheduled_at || item.created_at || 0)) || 0),
      0,
    );
    const daysSince = lastTime ? Math.max(0, (now - lastTime) / 86_400_000) : 1000;
    const minGap = Math.max(...channels.map((channel) => Number(rules.get(String(channel.id))?.min_product_gap_days || 14)), 14);
    const blockedByGap = lastTime > 0 && daysSince < minGap;
    const sameCategoryPenalty = product.category && product.category === latestCategory ? 80 : 0;
    const stockBonus = Math.min(50, Math.max(0, Number(product.stock || 0)));
    const neverPublishedBonus = related.length ? 0 : 500;
    const score = (blockedByGap ? -10_000 : 0) + neverPublishedBonus + daysSince * 5 + stockBonus - sameCategoryPenalty;
    return { ...product, _rotation_score: Math.round(score) };
  }).sort((left, right) => Number(right._rotation_score) - Number(left._rotation_score) || String(left.id).localeCompare(String(right.id)));
  return scored.find((item) => Number(item._rotation_score) > -9000) || scored[0] || null;
}

export function nextScheduleAt(schedule: ContentLogicRecord, after: Date) {
  if (schedule.recurrence_type === "once") return null;
  const rule = asObject(schedule.recurrence_rule);
  const times = stringArray(rule.times, 10).filter((value) => /^\d{2}:\d{2}$/.test(value)).sort();
  const timezone = String(schedule.timezone || "America/Santiago");
  const start = new Date(String(schedule.starts_at));
  const effectiveTimes = times.length ? times : [zonedTimeString(start, timezone)];
  const weekdays = stringArray(rule.weekdays, 7).map(Number);
  const intervalDays = Math.max(1, Number(rule.interval_days || 1));
  const startParts = zonedParts(start, timezone);
  const afterParts = zonedParts(new Date(after.getTime() + 1000), timezone);
  for (let offset = 0; offset <= 370; offset += 1) {
    const date = new Date(Date.UTC(afterParts.year, afterParts.month - 1, afterParts.day + offset));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    const daysFromStart = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(startParts.year, startParts.month - 1, startParts.day)) / 86_400_000);
    const validDate = schedule.recurrence_type === "daily"
      || (schedule.recurrence_type === "interval_days" && daysFromStart >= 0 && daysFromStart % intervalDays === 0)
      || (schedule.recurrence_type === "weekdays" && weekdays.includes(weekday));
    if (!validDate) continue;
    for (const time of effectiveTimes) {
      const [hour, minute] = time.split(":").map(Number);
      const candidate = zonedDateToUtc(year, month, day, hour, minute, timezone);
      if (candidate <= after || candidate < start) continue;
      if (schedule.ends_at && candidate > new Date(String(schedule.ends_at))) return null;
      return candidate;
    }
  }
  return null;
}

export function findSimilarDraft(
  variants: Array<{ body: string }>,
  recent: ContentLogicRecord[],
  threshold: number,
) {
  let closest: { similarity: number; body: string } | null = null;
  for (const variant of variants) {
    for (const publication of recent) {
      const similarity = textSimilarity(variant.body, String(publication.body || ""));
      if (similarity >= threshold && (!closest || similarity > closest.similarity)) {
        closest = { similarity, body: String(publication.body || "") };
      }
    }
  }
  return closest;
}

export function textSimilarity(left: string, right: string) {
  const tokens = (value: string) => new Set(
    normalize(value).split(/[^a-z0-9]+/).filter((token) => token.length >= 3),
  );
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function zonedDateToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string) {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = new Date(desired);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = zonedParts(candidate, timezone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate = new Date(candidate.getTime() + desired - actualUtc);
  }
  return candidate;
}

function zonedTimeString(date: Date, timezone: string) {
  const parts = zonedParts(date, timezone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function asObject(value: unknown): ContentLogicRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ContentLogicRecord : {};
}

function stringArray(value: unknown, limit: number) {
  return Array.isArray(value) ? value.slice(0, limit).map(String) : [];
}
