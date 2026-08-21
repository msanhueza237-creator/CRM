export type InstagramContainerState = {
  state: "ready" | "pending" | "failed";
  statusCode: string;
  message: string;
};

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
