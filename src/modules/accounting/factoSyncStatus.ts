type Run = { status: string; updated_at?: string | null; heartbeat_at?: string | null; lease_expires_at?: string | null };

export function factoHistoryStatus(run: Run, now = Date.now()): { label: string; tone: "success" | "danger" | "review" | "neutral" } {
  if (run.status === "completed") return { label: "Completada", tone: "success" };
  if (run.status === "partial") return { label: "Con observaciones", tone: "review" };
  if (run.status === "failed") return { label: "Fallida", tone: "danger" };
  if (run.status === "cancelled") return { label: "Cancelada", tone: "neutral" };
  if (run.status !== "running") return { label: "Estado desconocido", tone: "review" };
  const expiry = Date.parse(run.lease_expires_at || "");
  if (Number.isFinite(expiry) && expiry <= now) return { label: "Interrumpida; pendiente de recuperar", tone: "review" };
  const activity = Date.parse(run.heartbeat_at || run.updated_at || "");
  if (!Number.isFinite(expiry) && (!Number.isFinite(activity) || now - activity > 900_000)) {
    return { label: "Sin actividad confirmada; revisar", tone: "review" };
  }
  return { label: "En curso", tone: "review" };
}
