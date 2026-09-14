import type { ProspectCandidate, ProspectingRun } from "../../types/crm";

export function readEnrichmentPause(value: unknown): ProspectingRun["enrichmentPause"] {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (typeof row.reason_code !== "string" || !row.reason_code) return undefined;
  const resumeAfter = typeof row.resume_after === "string" && Number.isFinite(Date.parse(row.resume_after)) ? row.resume_after : "";
  return { reasonCode: row.reason_code, autoResume: row.auto_resume === true && !!resumeAfter,
    resumeAfter, dailyLimit: Number(row.daily_limit) || 20, dailyUsed: Number(row.daily_used) || 0 };
}

export function enrichmentPauseMessage(run: Pick<ProspectingRun, "id" | "enrichmentStatus" | "enrichmentPause">,
  candidates: Pick<ProspectCandidate, "runId" | "enrichmentError">[] = []): string {
  if (run.enrichmentStatus !== "paused") return "";
  const pause = run.enrichmentPause;
  // Historical pauses predate structured run metadata. Only known reason codes
  // are interpreted; worker errors are not copied into the interface.
  const reason = pause?.reasonCode ?? candidates.filter(c => c.runId === run.id)
    .map(c => c.enrichmentError.match(/^Investigacion pausada: (DAILY_LIMIT|RUN_LIMIT|INSUFFICIENT_BALANCE|RATE_LIMIT)$/)?.[1]).find(Boolean);
  if (reason === "DAILY_LIMIT") {
    return "El antiguo tope diario ya no aplica al analisis de candidatos. " + (pause?.autoResume
      ? "Los pendientes continuaran automaticamente, sujetos a saldo y disponibilidad del proveedor."
      : "Puedes reanudar los pendientes sin repetir los ya analizados.");
  }
  if (reason === "INSUFFICIENT_BALANCE") return "DeepSeek no tiene saldo suficiente. La investigacion se conserva en pausa; no se realizan recargas automaticas.";
  if (reason === "RATE_LIMIT") return "DeepSeek limito temporalmente las solicitudes. Los candidatos se conservan; puedes reanudar mas tarde.";
  if (reason === "RUN_LIMIT") return "La investigacion alcanzo el antiguo tope de esta ejecucion. Puedes continuar los candidatos pendientes sin repetir los analizados.";
  return "";
}
