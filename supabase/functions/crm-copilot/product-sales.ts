import { normalized, numeric, object, rows, type Row } from "./contracts.ts";
import { inRange } from "./dates.ts";
import { findProducts } from "./product-resolution.ts";

const key = (value: unknown) => normalized(value).replace(/[^a-z0-9]+/g, " ").trim();
const header = (record: Row) => ({ ...record, ...object(record.header) });
const fixed = (value: unknown): bigint | null => {
  const text = String(value ?? "");
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
};
const amount = (value: bigint) => Number(value) / 1000000;

// Invoice lines are evidence of sales, not stock changes or cash receipts.
export function productSales(documents: Row[], details: Row[], products: Row[], query: unknown, range: { from: string; to: string }, currencies: Record<string, string>) {
  const catalogMatches = new Set(findProducts(products, query).map((p) => p.sku));
  const groups = new Map<string, { row: Row; units: bigint; net: bigint; documents: Set<string>; revenueKnown: boolean }>();
  const problems: Row[] = [];
  const eligible = documents.filter((r) => {
    const h = header(r);
    return String(h.received_issued_flag) === "1" && ["33", "34", "39", "41", "56", "61"].includes(String(h.document_type_taxbureau)) && inRange(h.issue_date, range);
  });
  const seen = new Set<string>();
  let processed = 0;
  for (const document of eligible) {
    const h = header(document);
    const id = String(document.external_id);
    if (seen.has(id)) continue;
    seen.add(id);
    const candidates = details.filter((d) => String(d.external_id) === id);
    const detail = candidates[0];
    const lines = rows(detail?.details);
    const ref = { external_id: id, folio: h.document_number, date: h.issue_date, type: h.document_type_taxbureau };
    if (String(h.document_status) !== "1" || candidates.length !== 1 || !lines.length) {
      problems.push({ ...ref, problem: "Documento sin detalle unico o estado valido" }); continue;
    }
    const dh = header(detail);
    if ((dh.document_id != null && String(dh.document_id) !== id) || (dh.received_issued_flag != null && String(dh.received_issued_flag) !== "1") || (dh.document_type_taxbureau != null && String(dh.document_type_taxbureau) !== String(h.document_type_taxbureau))) {
      problems.push({ ...ref, problem: "Detalle con identidad o direccion inconsistente" }); continue;
    }
    // Credit/debit notes can correct text, amounts or annul a document. Never assume a quantity reversal.
    if (["56", "61"].includes(String(h.document_type_taxbureau))) {
      problems.push({ ...ref, problem: "Nota de credito/debito pendiente de asignacion por producto" }); continue;
    }
    processed++;
    const currency = currencies[String(h.currency_id)] || null;
    const units = lines.map((l) => fixed(l.quantity));
    const prices = lines.map((l) => fixed(l.unit_price));
    const lineNets = lines.map((_l, i) => units[i] !== null && prices[i] !== null ? (units[i]! * prices[i]! + 500000n) / 1000000n : null);
    const expected = numeric(h.net_amount ?? object(detail.totals).net_amount);
    const sum = lineNets.every((n) => n !== null) ? amount(lineNets.reduce<bigint>((a, n) => a + n!, 0n)) : null;
    const modifiers = rows(detail.global_modifiers).length > 0 || lines.some((l) => l.modifier_amount != null && numeric(l.modifier_amount) !== 0);
    const revenueKnown = !!currency && !modifiers && expected !== null && sum !== null && Math.abs(expected - sum) <= (currency === "CLP" ? 1 : 0.01);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const description = String(line.line_description || "");
      const text = key(description);
      const linked = products.filter((p) => key(p.name) === text || (Array.isArray(p.aliases) && p.aliases.some((a) => key(a) === text)));
      const product = linked.length === 1 ? linked[0] : null;
      if (query && !(product && catalogMatches.has(product.sku)) && !findProducts([{ name: description + " " + String(line.long_description || "") }], query).length) continue;
      if (!description || units[i] === null || units[i]! <= 0n) { problems.push({ ...ref, line: i + 1, problem: "Cantidad o descripcion no verificable" }); continue; }
      const groupKey = `${product?.sku || "description:" + text}|${currency || "unknown"}`;
      if (!groups.has(groupKey)) groups.set(groupKey, { row: { sku: product?.sku || null, name: product?.name || description, currency, identity: product ? "SKU por nombre exacto" : "Descripcion documental, SKU no confirmado", evidence: [], updated_at: detail.updated_at }, units: 0n, net: 0n, documents: new Set(), revenueKnown: true });
      const group = groups.get(groupKey)!;
      group.units += units[i]!;
      group.documents.add(id);
      group.revenueKnown &&= revenueKnown && lineNets[i] !== null;
      group.net += lineNets[i] || 0n;
      (group.row.evidence as Row[]).push({ ...ref, line: i + 1, quantity: amount(units[i]!), net: revenueKnown && lineNets[i] !== null ? amount(lineNets[i]!) : null, net_validation: revenueKnown ? "Validado contra neto documental" : !currency ? "Moneda desconocida" : modifiers ? "Ajuste o descuento requiere asignacion" : "Neto de lineas no cuadra con documento" });
    }
  }
  return {
    records: [...groups.values()].map<Row>((g) => ({ ...g.row, units_sold: amount(g.units), net_sales: g.revenueKnown ? amount(g.net) : null, document_count: g.documents.size })),
    coverage: { documents_found: seen.size, documents_processed: processed, problems },
  };
}
