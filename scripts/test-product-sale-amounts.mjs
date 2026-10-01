import test from "node:test";
import assert from "node:assert/strict";
import { productSales } from "../supabase/functions/crm-copilot/product-sales.ts";
import { withFactoSaleXml } from "../supabase/functions/crm-copilot/facto-sale-xml.ts";

const range = { from: "2026-01-01", to: "2026-09-30" };
const line = (name, quantity, unit_price, extra = {}) => ({ line_description: name, quantity, unit_price, vat_status: "1", ...extra });
function report(lines, net, modifiers, extra = {}) {
  const doc = { external_id: "550", header: { received_issued_flag: "1", document_type_taxbureau: "33", document_number: "1455", document_status: "1", issue_date: "2026-05-07", currency_id: "39", net_amount: net, ...extra } };
  const detail = { ...doc, details: lines, totals: { net_amount: net }, global_modifiers: modifiers };
  return productSales([doc], [detail], [], null, range, { 39: "CLP", 40: "USD" });
}
const discount = (value, value_type = "%") => ({ modifier_type: "DA", value, value_type });

test("Facto: 100 soportes a 5756 menos 20% = 460480, no costo de catalogo", () => {
  const r = report([line("Soporte", "100.000000", "5756.000000")], 460480, discount("20.00"));
  assert.equal(r.records[0].net_sales, 460480);
  assert.equal(r.records[0].average_net_unit_price, 4604.8);
  assert.equal(r.coverage.problems.length, 0);
});
test("Descuentos de linea firmados en pesos se aplican una sola vez", () => {
  const r = report([line("Bomba", 6, 28300, { modifier_amount: "-42450" })], 127350);
  assert.equal(r.records[0].net_sales, 127350);
  assert.equal(r.records[0].average_net_unit_price, 21225);
});
test("Descuento global en pesos se prorratea y cuadra en CLP", () => {
  const r = report([line("A", 3, 101), line("B", 2, 50)], 378, discount("25", "$"));
  assert.deepEqual(r.records.map(r => r.net_sales), [284, 94]);
  assert.equal(r.records.reduce((s, r) => s + r.net_sales, 0), 378);
});
test("Redondeos y multiples descuentos conservan el total documental", () => {
  const r = report([line("A", 3, "100.123456"), line("B", 2, "99.321000")], 359, [discount(10), discount(20)]);
  assert.equal(r.records.reduce((s, r) => s + r.net_sales, 0), 359);
  assert.ok(r.records.every(r => Number.isInteger(r.net_sales)));
});
test("Precio medio es ponderado despues de descuentos", () => {
  const r = report([line("A", 2, 100), line("A", 3, 200)], 800);
  assert.equal(r.records[0].units_sold, 5);
  assert.equal(r.records[0].average_net_unit_price, 160);
});
test("USD mantiene centavos y unidades fraccionarias", () => {
  const r = report([line("A", "1.5", "10.20")], "13.77", discount(10), { currency_id: "40" });
  assert.equal(r.records[0].net_sales, 13.77);
  assert.equal(r.records[0].average_net_unit_price, 9.18);
});
test("Ajustes ambiguos, negativos, desconocidos o descuadres no se fuerzan", () => {
  const cases = [
    report([line("A", 1, 100)], 70),
    report([line("A", 1, 100)], 90, { ...discount(10), modifier_type: "unknown" }),
    report([line("A", 1, 100)], 90, "bad"),
    report([line("A", 1, 100)], 90, { ...discount(10), value_type: "?" }),
    report([line("A", 1, 100, { vat_status: null })], 90, discount(10)),
    report([line("A", 1, 100, { modifier_amount: "-110" })], 0),
    report([line("A", 1, 100, { modifier_amount: -10, modifier_percentage: -10 })], 90),
    report([line("A", 1, 100)], 0, discount(110)),
    report([line("A", 1, 100)], 90, discount(10), { currency_id: "missing" }),
  ];
  for (const r of cases) {
    assert.equal(r.records[0].net_sales, null);
    assert.equal(r.records[0].average_net_unit_price, null);
    assert.ok(r.coverage.problems.length);
  }
});
test("No infiere devoluciones de notas ni mezcla moneda de detalle", () => {
  assert.equal(report([line("A", 1, 100)], 100, null, { document_type_taxbureau: "61" }).records.length, 0);
  const doc = { external_id: "1", received_issued_flag: "1", document_type_taxbureau: "33", document_status: "1", issue_date: "2026-05-07", currency_id: "39", net_amount: 100 };
  const r = productSales([doc], [{ ...doc, currency_id: "40", details: [line("A", 1, 100)] }], [], null, range, { 39: "CLP", 40: "USD" });
  assert.equal(r.records[0].net_sales, null);
});

const xml = `<DTE><Documento><Encabezado><IdDoc><TipoDTE>33</TipoDTE><Folio>1455</Folio><FchEmis>2026-05-07</FchEmis></IdDoc><Emisor><RUTEmisor>76500000-1</RUTEmisor></Emisor><Receptor><RUTRecep>76919986-1</RUTRecep></Receptor><Totales><MntNeto>55080</MntNeto><IVA>10465</IVA><MntTotal>65545</MntTotal></Totales></Encabezado><Detalle><NroLinDet>1</NroLinDet><CdgItem><TpoCodigo>SKU</TpoCodigo><VlrCodigo>ST-5030</VlrCodigo></CdgItem><NmbItem>Cinta</NmbItem><QtyItem>90</QtyItem><PrcItem>720</PrcItem><DescuentoPct>15</DescuentoPct><DescuentoMonto>9720</DescuentoMonto><MontoItem>55080</MontoItem></Detalle></Documento></DTE>`;
const xmlDetail = (input = xml) => ({external_id:"550", header:{received_issued_flag:"1",document_type_taxbureau:"33",document_status:"1",document_number:"1455",issue_date:"2026-05-07",currency_id:"39",issuer_tax_id_code:"76500000-1",receiver_tax_id_code:"76919986-1"}, details:[line("Cinta",90,720)],totals:{net_amount:55080},document_xml:Buffer.from(input).toString("base64")});
test("XML recupera descuentos omitidos por JSON, no expone XML ni usa el costo", async()=>{
  const d=xmlDetail(), parsed=await withFactoSaleXml(d,{39:"CLP"});
  assert.equal(parsed.sale_xml_status,"verified"); assert.equal(parsed.document_xml,undefined);
  assert.equal(d.details[0].modifier_amount,undefined);
  const r=productSales([d],[parsed],[],null,range,{39:"CLP"});
  assert.equal(r.records[0].net_sales,55080); assert.equal(r.records[0].average_net_unit_price,612);
  assert.equal(r.records[0].sku,"ST-5030"); assert.equal(r.records[0].identity,"SKU del XML de Facto");
});
test("XML contrario a identidad, precio, unidades o total nunca se aplica",async()=>{
  for(const [before,after] of [["<Folio>1455","<Folio>1456"],["76500000-1","99999999-9"],["76919986-1","99999999-9"],["<QtyItem>90","<QtyItem>80"],["<PrcItem>720","<PrcItem>700"],["<MntNeto>55080","<MntNeto>55081"],["<MontoItem>55080","<MontoItem>55082"]]){
    const d=xmlDetail(xml.replace(before,after)),parsed=await withFactoSaleXml(d,{39:"CLP"});
    assert.equal(parsed.sale_xml_status,"invalid",before);
    assert.equal(productSales([d],[parsed],[],null,range,{39:"CLP"}).records[0].net_sales,null);
  }
});
test("XML inseguro, truncado o excesivo se retiene sin evaluar entidades",async()=>{
  for(const value of ['<!DOCTYPE DTE [<!ENTITY file SYSTEM "file:///etc/passwd">]>'+xml,xml.slice(0,-6),'a'.repeat(1000001)]) {
    const result=await withFactoSaleXml(xmlDetail(value),{39:"CLP"});
    assert.equal(result.sale_xml_status,"invalid"); assert.equal(result.document_xml,undefined);
  }
});
test("XML y JSON con descuentos distintos se retienen; ajustes globales no se duplican",async()=>{
  const wrong=xmlDetail();wrong.details[0].modifier_amount=-100;
  assert.equal((await withFactoSaleXml(wrong,{39:"CLP"})).sale_xml_status,"invalid");
  const source=xml.replace('<MntNeto>55080','<MntNeto>49572').replace('</Documento>','<DscRcgGlobal><NroLinDR>1</NroLinDR><TpoMov>D</TpoMov><TpoValor>%</TpoValor><ValorDR>10</ValorDR></DscRcgGlobal></Documento>');
  const d=xmlDetail(source);d.totals.net_amount=49572;d.global_modifiers=discount(10);
  const parsed=await withFactoSaleXml(d,{39:"CLP"});
  assert.equal(parsed.sale_xml_status,"verified");
  assert.equal(productSales([d],[parsed],[],null,range,{39:"CLP"}).records[0].net_sales,49572);
});
