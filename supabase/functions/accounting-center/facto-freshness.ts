// This describes the available mirror, never guarantees a live read from Facto.
export const FACTO_READING_WARNING_MS = 24 * 60 * 60 * 1000;
type Row = Record<string, unknown>;
function timestamp(value: unknown): string | null {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
export function buildFactoFreshness(connectionStatus: string, reading: unknown, latest: Row | undefined, successful: Row | undefined, now = Date.now()) {
  const integrationUpdatedAt = timestamp(reading);
  const accountingSyncedAt = successful?.status === "completed" ? timestamp(successful.completed_at) : null;
  const successfulStartedAt = timestamp(successful?.created_at);
  const lastAttemptAt = timestamp(latest?.created_at);
  const lastAttemptStatus = typeof latest?.status === "string" ? latest.status : null;
  let state = "unknown";
  if (lastAttemptStatus === "failed" || lastAttemptStatus === "cancelled" || lastAttemptStatus === "partial" || lastAttemptStatus === "running") state = lastAttemptStatus;
  else if (integrationUpdatedAt && Date.parse(integrationUpdatedAt) <= now) {
    if (now - Date.parse(integrationUpdatedAt) > FACTO_READING_WARNING_MS) state = "old_reading";
    else if (!accountingSyncedAt || !successfulStartedAt || integrationUpdatedAt > successfulStartedAt) state = "pending";
    else if (lastAttemptStatus === "completed" && connectionStatus === "connected" && Date.parse(accountingSyncedAt) <= now) state = "mirror_consolidated";
  }
  return { connectionStatus, integrationUpdatedAt, accountingSyncedAt, lastAttemptAt, lastAttemptStatus, state, stale: state !== "mirror_consolidated" };
}
