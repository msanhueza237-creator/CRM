import type { HistoricalImportPreview } from "../../types/crm";

type PreviewRequest = {
  file: File;
  relationshipDate: string;
  serviceUrl: string | undefined;
  accessToken: string;
  fetcher?: typeof fetch;
};

export async function requestHistoricalPreview({
  file, relationshipDate, serviceUrl, accessToken, fetcher = fetch,
}: PreviewRequest): Promise<HistoricalImportPreview> {
  if (!/\.(csv|xlsx|xls)$/i.test(file.name)) throw new Error("Selecciona un archivo CSV, XLSX o XLS.");
  if (file.size > 25 * 1024 * 1024) throw new Error("El archivo supera el límite de 25 MB.");
  if (!accessToken) throw new Error("Inicia sesión en el CRM para analizar archivos.");
  let origin: URL;
  try { origin = new URL(serviceUrl?.trim() || ""); }
  catch { throw new Error("El servicio de importación aún no está configurado. Contacta al administrador."); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash
      || !["", "/"].includes(origin.pathname)
      || origin.hostname === "localhost" || origin.hostname.endsWith(".localhost")
      || origin.hostname.startsWith("127.") || origin.hostname === "[::1]") {
    throw new Error("El servicio de importación debe usar una dirección HTTPS del servidor.");
  }
  const url = new URL("/api/historical-imports/preview", origin);
  if (relationshipDate) {
    const parsed = new Date(`${relationshipDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(relationshipDate) || Number.isNaN(parsed.getTime())
        || parsed.toISOString().slice(0, 10) !== relationshipDate) {
      throw new Error("La fecha de la relación no es válida.");
    }
    url.searchParams.set("relationship_date", relationshipDate);
  }
  const body = new FormData();
  body.append("file", file);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST", body, headers: { Authorization: `Bearer ${accessToken}` },
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("No fue posible contactar al servicio de importación. Inténtalo nuevamente.");
  }
  if (response.status === 401) throw new Error("La sesión expiró. Vuelve a iniciar sesión.");
  if (response.status === 403) throw new Error("No tienes permiso para importar archivos históricos.");
  if (response.status === 413) throw new Error("El archivo supera el límite de 25 MB.");
  if (response.status === 503) throw new Error("El servicio de importación no está disponible. Contacta al administrador.");
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof payload?.detail === "string" ? payload.detail : "No fue posible analizar el archivo.");
  }
  if (!payload || !Array.isArray(payload.rows) || !Array.isArray(payload.preview)
      || !Array.isArray(payload.sheets) || !payload.stats || typeof payload.sha256 !== "string") {
    throw new Error("El servicio de importación devolvió una respuesta no válida.");
  }
  return payload;
}
