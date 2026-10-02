type Row = Record<string, unknown>;
type Element = { name: string; text: string; namespace: string; children: Element[] };
const object = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const aliases = {
  total: ["total", "total_amount", "monto_total", "amount"],
  net: ["net", "net_amount", "monto_neto", "total_neto"],
  tax: ["tax", "vat", "iva", "monto_iva", "taxes_amount"],
  exempt: ["exempt", "exempt_amount", "monto_exento"],
};

// Do not let coercion of null, booleans, objects or malformed text manufacture zero.
export function amountPresence(value: unknown): "missing" | "invalid" | "present" {
  if (value == null || (typeof value === "string" && !value.trim())) return "missing";
  if (typeof value === "number") return Number.isFinite(value) ? "present" : "invalid";
  return typeof value === "string" && /^-?(?:\d+(?:[.,]\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:\.\d{3})+(?:,\d+)?)$/.test(value.trim()) ? "present" : "invalid";
}
function explicitZero(value: unknown) {
  return amountPresence(value) === "present" && /^-?0+(?:[.,]0+)*$/.test(String(value).trim());
}
function zeros(row: Row, keys: string[], required: boolean) {
  const supplied = keys.filter(k => row[k] !== undefined && row[k] !== null && row[k] !== "");
  return (!required || supplied.length > 0) && supplied.every(k => explicitZero(row[k]));
}
function one(node: Element | undefined, name: string): Element | undefined {
  const found = node?.children.filter(c => c.name === name && c.namespace === "http://www.sii.cl/SiiDte") || [];
  return found.length === 1 ? found[0] : undefined;
}
function text(node: Element | undefined, name: string) {
  const child = one(node, name);
  return child && child.children.length === 0 ? child.text.trim() : null;
}
function integer(node: Element | undefined, name: string) {
  const value = text(node, name);
  if (value === null || !/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}
const rut = (v: unknown) => String(v ?? "").replace(/[.\-\s]/g, "").toUpperCase();

// A bounded, conservative XML subset reader, NOT a DTE/signature validator.
// Unsupported XML (DTD/entities/CDATA/namespaced elements) fails closed. Parse the
// whole tree so a regex match inside a comment/signature cannot supply evidence.
function readXml(input: unknown): Element | undefined {
  if (typeof input !== "string" || !input.trim() || input.length > 1_400_000) return;
  let xml = input.trim();
  if (!xml.startsWith("<")) {
    if (!/^[A-Za-z0-9+/=\s]+$/.test(xml)) return;
    try { xml = atob(xml.replace(/\s/g, "")).trim(); } catch { return; }
  }
  if (xml.length > 1_000_000 || /<!|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)) return;
  xml = xml.replace(/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["'][A-Za-z0-9-]+["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>\s*/, "");
  const root: Element = { name: "", text: "", namespace: "", children: [] };
  const stack = [root];
  const token = /<[^>]*>|[^<]+/gy;
  let match: RegExpExecArray | null;
  let end = 0, count = 0;
  while ((match = token.exec(xml))) {
    end = token.lastIndex;
    const part = match[0], parent = stack[stack.length - 1];
    if (++count > 20000) return;
    if (!part.startsWith("<")) {
      if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(part) || part.includes("]]>")) return;
      parent.text += part;
      continue;
    }
    const closing = part.match(/^<\/([A-Za-z_][\w.-]*)\s*>$/);
    if (closing) {
      if (stack.length === 1 || parent.name !== closing[1]) return;
      if (parent.children.length && parent.text.trim()) return;
      stack.pop(); continue;
    }
    const opening = part.match(/^<([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*(\/?)>$/);
    if (!opening || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(opening[2])) return;
    const attributes = [...opening[2].matchAll(/([A-Za-z_][\w.:-]*)\s*=/g)].map(a => a[1]);
    if (new Set(attributes).size !== attributes.length) return;
    const namespace = opening[2].match(/\sxmlns\s*=\s*["']([^"']*)["']/)?.[1] ?? parent.namespace;
    const child: Element = { name: opening[1], text: "", namespace, children: [] };
    parent.children.push(child);
    if (!opening[3]) stack.push(child);
    if (stack.length > 64) return;
  }
  if (end !== xml.length || stack.length !== 1 || root.children.length !== 1 || root.text.trim()) return;
  return root.children[0];
}

/** Evidence only: never adds non-billable amounts to purchase/VAT/payment totals. */
export function nonBillableZeroEvidence(document: Row, purchase: boolean) {
  if (!purchase || String(document.document_type_taxbureau ?? document.tax_document_type) !== "34"
    || String(document.received_issued_flag) !== "0"
    || String(document.currency_id) !== "39"
    || ["currency", "moneda", "currency_code"].some(k => document[k] != null && String(document[k]).toUpperCase() !== "CLP")
    || ["exchange_rate", "exchange_rate_value", "tipo_cambio", "dolar"].some(k => document[k] != null && document[k] !== "" && Number(document[k]) !== 1)
    || !zeros(document, aliases.total, true) || !zeros(document, aliases.net, true)
    || !zeros(document, aliases.tax, true) || !zeros(document, aliases.exempt, false)) return null;
  const root = readXml(object(document.electronic_document).document_xml);
  if (root?.name !== "DTE" || root.namespace !== "http://www.sii.cl/SiiDte") return null;
  const body = one(root, "Documento"), header = one(body, "Encabezado");
  const id = one(header, "IdDoc"), totals = one(header, "Totales");
  const issuer = text(one(header, "Emisor"), "RUTEmisor"), receiver = text(one(header, "Receptor"), "RUTRecep");
  const folio = String(document.folio ?? document.number ?? document.document_number ?? document.numero ?? "");
  const date = String(document.issued_on ?? document.issue_date ?? document.date ?? document.fecha_emision ?? document.fecha ?? "");
  if (!body || !header || !id || !totals || header.text.trim() || body.text.trim()
    || text(id, "TipoDTE") !== "34" || text(id, "Folio") !== folio
    || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date || text(id, "FchEmis") !== date
    || !/^\d{7,8}[0-9K]$/.test(rut(issuer)) || !/^\d{7,8}[0-9K]$/.test(rut(receiver))
    || rut(issuer) !== rut(document.issuer_tax_id_code) || rut(receiver) !== rut(document.receiver_tax_id_code)
    || integer(totals, "MntTotal") !== 0 || integer(totals, "MntExe") !== 0) return null;
  // No unmodeled taxes, previous balance or duplicate totals may be ignored.
  const allowed = new Set(["MntTotal", "MntExe", "MntNeto", "IVA", "MontoNF", "MontoPeriodo"]);
  if (totals.text.trim() || totals.children.some(c => !allowed.has(c.name) || c.namespace !== "http://www.sii.cl/SiiDte")
    || new Set(totals.children.map(c => c.name)).size !== totals.children.length
    || ["MntNeto", "IVA"].some(k => totals.children.some(c => c.name === k) && integer(totals, k) !== 0)) return null;
  const nonBillable = integer(totals, "MontoNF"), period = integer(totals, "MontoPeriodo");
  if (nonBillable === null || nonBillable <= 0 || period !== nonBillable) return null;
  const lines = body.children.filter(c => c.name === "Detalle");
  let sum = 0;
  const numbers = new Set<number>();
  for (const line of lines) {
    const amount = integer(line, "MontoItem"), number = integer(line, "NroLinDet");
    if (line.namespace !== "http://www.sii.cl/SiiDte" || text(line, "IndExe") !== "2" || amount === null || amount <= 0 || number === null || number < 1
      || numbers.has(number) || line.text.trim()) return null;
    numbers.add(number); sum += amount;
    if (!Number.isSafeInteger(sum)) return null;
  }
  if (!lines.length || sum !== nonBillable) return null;
  return { source: "facto_dte_xml" as const, billableTotal: 0, nonBillableAmount: nonBillable,
    periodAmount: period, detailCount: lines.length, requiresAccountingReview: true as const };
}
