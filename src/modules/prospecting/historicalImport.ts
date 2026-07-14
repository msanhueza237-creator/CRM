import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import type { HistoricalImportBatch, HistoricalImportPreview } from "../../types/crm";

const BATCH_STORAGE_KEY = "climactiva_historical_batches_v1";
const AGENT_URL = (import.meta.env.VITE_AGENT_LOCAL_URL as string | undefined) ?? "http://localhost:8000";

function readLocal<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}

export async function previewHistoricalFile(file: File, relationshipDate: string): Promise<HistoricalImportPreview> {
  const body = new FormData();
  body.append("file", file);
  const query = relationshipDate ? `?relationship_date=${encodeURIComponent(relationshipDate)}` : "";
  let response: Response;
  try {
    response = await fetch(`${AGENT_URL}/api/historical-imports/preview${query}`, { method: "POST", body });
  } catch {
    throw new Error("No fue posible conectar con el agente local. Inícialo para analizar CSV o Excel.");
  }
  const payload = (await response.json().catch(() => ({}))) as HistoricalImportPreview & { detail?: string };
  if (!response.ok) throw new Error(payload.detail ?? "El agente no pudo analizar el archivo.");
  return payload;
}

export async function listHistoricalBatches(): Promise<HistoricalImportBatch[]> {
  if (!isSupabaseConfigured || !supabase) return readLocal<HistoricalImportBatch[]>(BATCH_STORAGE_KEY, []);
  const { data, error } = await supabase.from("historical_import_batches").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: String(row.id), filename: String(row.filename), fileSha256: String(row.file_sha256),
    status: row.status, relationshipDate: row.relationship_date, sourceRowCount: Number(row.source_row_count),
    entityCount: Number(row.entity_count), duplicateCount: Number(row.duplicate_count),
    needsReviewCount: Number(row.needs_review_count), sheets: row.sheet_names ?? [], createdAt: String(row.created_at),
  }));
}

export async function commitHistoricalImport(preview: HistoricalImportPreview): Promise<HistoricalImportBatch> {
  if (!isSupabaseConfigured || !supabase) {
    const batches = readLocal<HistoricalImportBatch[]>(BATCH_STORAGE_KEY, []);
    const duplicate = batches.find((batch) => batch.fileSha256 === preview.sha256 && batch.status !== "rolled_back");
    if (duplicate) return duplicate;
    const batch: HistoricalImportBatch = {
      id: crypto.randomUUID(), filename: preview.filename, fileSha256: preview.sha256,
      status: (preview.stats.needs_review ?? 0) > 0 ? "partial" : "ready",
      relationshipDate: preview.relationship_date, sourceRowCount: preview.stats.source_rows ?? preview.rows.length,
      entityCount: preview.rows.length, duplicateCount: preview.stats.duplicates_consolidated ?? 0,
      needsReviewCount: preview.stats.needs_review ?? 0, sheets: preview.sheets, createdAt: new Date().toISOString(),
    };
    await saveLocalEntities(batch.id, preview.rows);
    localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify([batch, ...batches]));
    return batch;
  }

  const { data: created, error: createError } = await supabase.rpc("create_historical_import_batch", {
    p_filename: preview.filename, p_file_sha256: preview.sha256,
    p_relationship_date: preview.relationship_date, p_source_row_count: preview.stats.source_rows ?? preview.rows.length,
    p_sheet_names: preview.sheets, p_authorization_confirmed: true,
  });
  if (createError) throw createError;
  const row = Array.isArray(created) ? created[0] : created;
  if (!row?.id) throw new Error("El CRM no devolvió el lote creado.");
  if (row.status === "processing") {
    for (let index = 0; index < preview.rows.length; index += 500) {
      const { error } = await supabase.rpc("upsert_historical_import_rows", {
        p_batch_id: row.id, p_rows: preview.rows.slice(index, index + 500),
      });
      if (error) throw error;
    }
    const { data: completed, error } = await supabase.rpc("complete_historical_import_batch", {
      p_batch_id: row.id, p_stats: preview.stats,
    });
    if (error) throw error;
    return mapBatch(Array.isArray(completed) ? completed[0] : completed);
  }
  return mapBatch(row);
}

function saveLocalEntities(batchId: string, rows: HistoricalImportPreview["rows"]): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("climactiva-prospecting", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("historical_entities")) {
        const store = database.createObjectStore("historical_entities", { keyPath: "storageKey" });
        store.createIndex("batchId", "batchId");
      }
    };
    request.onerror = () => reject(new Error("No fue posible abrir el almacenamiento local."));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("historical_entities", "readwrite");
      const store = transaction.objectStore("historical_entities");
      rows.forEach((row) => store.put({ ...row, batchId, storageKey: `${batchId}:${row.identity_key}` }));
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(new Error("No fue posible guardar la base histórica local.")); };
    };
  });
}

export async function rollbackHistoricalBatch(batchId: string): Promise<void> {
  if (!isSupabaseConfigured || !supabase) {
    const batches = readLocal<HistoricalImportBatch[]>(BATCH_STORAGE_KEY, []);
    localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(batches.map((batch) =>
      batch.id === batchId ? { ...batch, status: "rolled_back" as const } : batch)));
    await deleteLocalBatchEntities(batchId);
    return;
  }
  const { error } = await supabase.rpc("rollback_historical_import_batch", { p_batch_id: batchId });
  if (error) throw error;
}

function deleteLocalBatchEntities(batchId: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.open("climactiva-prospecting", 1);
    request.onerror = () => resolve();
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("historical_entities")) { database.close(); resolve(); return; }
      const transaction = database.transaction("historical_entities", "readwrite");
      const index = transaction.objectStore("historical_entities").index("batchId");
      const cursor = index.openKeyCursor(IDBKeyRange.only(batchId));
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (current) { transaction.objectStore("historical_entities").delete(current.primaryKey); current.continue(); }
      };
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); resolve(); };
    };
  });
}

function mapBatch(row: Record<string, unknown>): HistoricalImportBatch {
  return {
    id: String(row.id), filename: String(row.filename), fileSha256: String(row.file_sha256),
    status: row.status as HistoricalImportBatch["status"], relationshipDate: row.relationship_date as string | null,
    sourceRowCount: Number(row.source_row_count), entityCount: Number(row.entity_count),
    duplicateCount: Number(row.duplicate_count), needsReviewCount: Number(row.needs_review_count),
    sheets: (row.sheet_names as string[]) ?? [], createdAt: String(row.created_at),
  };
}
