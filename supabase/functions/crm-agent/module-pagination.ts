type Row = Record<string, unknown>;
export async function collectModuleRows(fetchPage: (offset: number, size: number) => Promise<{ rows: Row[]; total: number | null }>, maxRows = 50000) {
  const result: Row[] = [];
  let expected: number | null = null;
  for (;;) {
    const page = await fetchPage(result.length, 500);
    if (page.total === null || !Number.isSafeInteger(page.total) || page.total < 0 || page.total > maxRows) throw new Error("module_coverage_unverified");
    if (expected !== null && expected !== page.total) throw new Error("module_changed_during_read");
    expected = page.total;
    result.push(...page.rows);
    if (result.length > expected) throw new Error("module_coverage_inconsistent");
    if (result.length === expected) return result;
    if (!page.rows.length) throw new Error("module_read_incomplete");
  }
}
