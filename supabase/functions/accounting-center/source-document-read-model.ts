type Row = Record<string, unknown>;

// Embedded electronic files are evidence, not part of the financial screen's read model.
// Leave the original payload in storage and preserve all financial/header fields.
function withoutElectronicFiles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutElectronicFiles);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "electronic_document")
    .map(([key, child]) => [key, withoutElectronicFiles(child)]));
}

export async function readSourceDocumentSummaries(
  readPage: (path: string) => Promise<Row[]>,
  entityId: string,
): Promise<Row[]> {
  const rows: Row[] = [];
  const pageSize = 25;
  for (let offset = 0; offset < 50000; offset += pageSize) {
    const page = await readPage(`accounting_source_documents?select=*&entity_id=eq.${entityId}&order=issued_on.desc.nullslast,id.asc&limit=${pageSize}&offset=${offset}`);
    for (const row of page) rows.push({ ...row, raw_payload: withoutElectronicFiles(row.raw_payload) });
    if (page.length < pageSize) return rows;
  }
  throw new Error("La lectura documental supera el limite verificable. No se entregaran totales parciales.");
}
