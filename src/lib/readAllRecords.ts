export async function readAllRecords<T extends { id: string }>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; count: number | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [], ids = new Set<string>();
  let expected: number | null = null;
  for (;;) {
    const result = await page(rows.length, rows.length + 499);
    if (result.error) throw new Error(result.error.message);
    if (result.count === null || (expected !== null && expected !== result.count)) throw new Error("La lista cambió durante la lectura. Actualiza para consultar el detalle completo.");
    expected = result.count;
    for (const row of result.data || []) {
      if (ids.has(row.id)) throw new Error("La lectura repitió registros. No se mostrará una lista incompleta.");
      ids.add(row.id); rows.push(row);
    }
    if (rows.length === expected) return rows;
    if (!result.data?.length || rows.length > expected || rows.length >= 50000) throw new Error("No se pudo completar la lectura de todos los registros.");
  }
}
