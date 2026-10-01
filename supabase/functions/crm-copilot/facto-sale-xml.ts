import { normalized, object, rows, type Row } from "./contracts.ts";

type XmlLibrary = { XMLParser: new (options: Row) => { parse(xml: string): Row }; XMLValidator: { validate(xml: string): true | unknown } };
let library: Promise<XmlLibrary> | undefined;
const list = (value: unknown) => value == null ? [] : Array.isArray(value) ? value : [value];
const tax = (value: unknown) => normalized(value).replace(/[^a-z0-9]/g, "");
const text = (value: unknown) => normalized(value).replace(/\s+/g, " ").trim();
const number = (value: unknown): number | null => /^\d{1,12}(?:\.\d{1,6})?$/.test(String(value ?? "")) && Number.isFinite(Number(value)) ? Number(value) : null;

/** Read-only recovery of discounts omitted by Facto JSON, from the same invoice's DTE XML. */
export async function withFactoSaleXml(detail: Row, currencies: Record<string, string>): Promise<Row> {
  const { document_xml: encoded, ...record } = detail;
  if (encoded == null || encoded === "") return record;
  const h = { ...detail, ...object(detail.header) };
  if (currencies[String(h.currency_id)] !== "CLP" || !["33", "39"].includes(String(h.document_type_taxbureau))) return record;
  try {
    if (typeof encoded !== "string" || encoded.length > 1000000 || !/^[A-Za-z0-9+/=\s]+$/.test(encoded)) throw Error();
    const bytes = Uint8Array.from(atob(encoded.replace(/\s/g, "")), c => c.charCodeAt(0));
    let xml: string;
    try { xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { xml = new TextDecoder("iso-8859-1").decode(bytes); }
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error();
    const nodeSpecifier = "fast-xml-parser";
    const { XMLParser, XMLValidator } = await (library ??= typeof Deno === "undefined" ? import(nodeSpecifier) : import("npm:fast-xml-parser@5.11.2"));
    if (XMLValidator.validate(xml) !== true) throw Error();
    const root = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false }).parse(xml);
    const dte = object(root.DTE), document = object(dte.Documento), head = object(document.Encabezado);
    const id = object(head.IdDoc), totals = object(head.Totales), issuer = object(head.Emisor), receiver = object(head.Receptor);
    if (!Object.keys(document).length || String(id.TipoDTE) !== String(h.document_type_taxbureau) || String(id.Folio) !== String(h.document_number)
      || String(id.FchEmis) !== String(h.issue_date).slice(0, 10) || !tax(h.issuer_tax_id_code) || tax(issuer.RUTEmisor) !== tax(h.issuer_tax_id_code)
      || !tax(h.receiver_tax_id_code) || tax(receiver.RUTRecep) !== tax(h.receiver_tax_id_code)
      || (id.MntBruto != null && String(id.MntBruto) !== "0") || head.OtraMoneda != null
      || (totals.TpoMoneda != null && !["PESO CL", "CLP"].includes(String(totals.TpoMoneda)))) throw Error();
    const expected = number(h.net_amount ?? object(detail.totals).net_amount), net = number(totals.MntNeto);
    if (net === null || expected === null || expected !== net || (totals.MntExe != null && number(totals.MntExe) !== 0)) throw Error();
    const apiLines = rows(detail.details), xmlLines = list(document.Detalle).map(object);
    if (!apiLines.length || apiLines.length !== xmlLines.length) throw Error();
    const enriched = apiLines.map((line, index) => {
      const x = xmlLines[index], qty = number(x.QtyItem), price = number(x.PrcItem), lineNet = number(x.MontoItem);
      const discount = x.DescuentoMonto == null ? 0 : number(x.DescuentoMonto), surcharge = x.RecargoMonto == null ? 0 : number(x.RecargoMonto);
      if (String(x.NroLinDet) !== String(index + 1) || qty === null || price === null || lineNet === null || discount === null || surcharge === null
        || qty !== number(line.quantity) || price !== number(line.unit_price) || text(x.NmbItem) !== text(line.line_description)
        || x.IndExe != null || Math.abs(qty * price - discount + surcharge - lineNet) > 1) throw Error();
      if (line.modifier_amount != null && Number(line.modifier_amount) !== surcharge - discount) throw Error();
      const codes = list(x.CdgItem).map(object).filter(c => c.TpoCodigo === "SKU");
      return { ...line, modifier_amount: String(surcharge - discount), modifier_percentage: null,
        validated_xml_line_net: String(lineNet), validated_xml_sku: codes.length === 1 ? String(codes[0].VlrCodigo || "") : null, vat_status: "1" };
    });
    const globalModifiers = list(document.DscRcgGlobal).map((value, index) => {
      const x = object(value);
      if (String(x.NroLinDR) !== String(index + 1) || !["D", "R"].includes(String(x.TpoMov)) || !["%", "$"].includes(String(x.TpoValor)) || number(x.ValorDR) === null || x.IndExeDR != null) throw Error();
      return { modifier_type: x.TpoMov === "D" ? "DA" : "RA", value_type: String(x.TpoValor), value: String(x.ValorDR) };
    });
    if (detail.global_modifiers != null) {
      const api = list(detail.global_modifiers).map(object);
      if (api.length !== globalModifiers.length || api.some((m, i) => m.modifier_type !== globalModifiers[i].modifier_type || m.value_type !== globalModifiers[i].value_type || number(m.value) !== number(globalModifiers[i].value))) throw Error();
    }
    return { ...record, details: enriched, global_modifiers: globalModifiers, sale_xml_status: "verified" };
  } catch {
    // Conflicting or malformed XML cannot silently override either source.
    return { ...record, sale_xml_status: "invalid" };
  }
}
