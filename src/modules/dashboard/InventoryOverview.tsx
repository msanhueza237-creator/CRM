import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Boxes, ChevronDown, ChevronLeft, ChevronRight, Search, X, Sparkles } from "lucide-react";
import { getInventoryValuation, type InventoryResult } from "../../lib/inventoryApi";
import "./inventory.css";

const number = (v: number | null | undefined) => v == null ? "No disponible" : v.toLocaleString("es-CL", { maximumFractionDigits: 2 });
const money = (v: number | null | undefined, currency: string | null = "CLP") => v == null ? "No disponible" : currency
  ? v.toLocaleString("es-CL", { style: "currency", currency, maximumFractionDigits: currency === "CLP" ? 0 : 2 }) : number(v);
const date = (v: string | null | undefined) => v ? new Date(v).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short", timeZone: "America/Santiago" }) : "Sin fecha";

export function InventoryOverview({ refreshedAt, userId }: { refreshedAt: string | null; userId: string }) {
  const [params, setParams] = useSearchParams();
  const query = params.get("inventory_query") || "", brand = params.get("inventory_brand") || "";
  const stock = params.get("inventory_stock_filter") || "all", list = params.get("inventory_list_id") || "";
  const threshold = params.get("inventory_threshold") || "10";
  const [draft, setDraft] = useState(query);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<InventoryResult | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState("");
  const [currency, setCurrency] = useState("CLP");
  const filtered = !!query || !!brand || !!list || stock !== "all";
  useEffect(() => { setDraft(query); }, [query]);
  useEffect(() => {
    if (!refreshedAt) return;
    const abort = new AbortController();
    setBusy(true); setError(""); setResult(null);
    getInventoryValuation({ query, brand, stock_filter: stock, list_id: list, threshold, offset, limit: 25, sort: "name" }, abort.signal)
      .then(value => { if (!abort.signal.aborted) setResult(value); })
      .catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Inventario no disponible."); })
      .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [query, brand, stock, list, threshold, offset, refreshedAt, userId]);
  function update(key: string, value: string) {
    setOffset(0);
    setParams(current => { const next = new URLSearchParams(current); value ? next.set(`inventory_${key}`, value) : next.delete(`inventory_${key}`); return next; }, { replace: true });
  }
  function search(e: FormEvent) { e.preventDefault(); update("query", draft.trim()); }
  function clear() {
    setOffset(0); setDraft("");
    setParams(current => { const next = new URLSearchParams(current); [...next.keys()].filter(k => k.startsWith("inventory_")).forEach(k => next.delete(k)); return next; }, { replace: true });
  }
  const data = result?.data, totals = data?.totals;
  const values = totals?.by_currency.find(c => c.currency === currency) || totals?.by_currency[0];
  const code = values?.currency || currency;
  const conditional = (values?.conditional_cost_products || 0) > 0;
  const prompt = `Consulta el inventario${query ? ` de ${query}` : " completo"}${brand ? ` de la marca ${brand}` : ""}: unidades, costo total y valor de venta neto. Filtro de stock: ${stock}.${stock === "low" ? ` Umbral: menos de ${threshold} unidades.` : ""}${list ? ` Lista Facto: ${list}.` : ""} Incluye cobertura, moneda y fechas de origen.`;
  const copilot = `/copiloto?inventory_query=${encodeURIComponent(prompt)}`;
  return <section className="overview-section inventory-overview" id="inventario" aria-label="Inventario actual" aria-busy={busy}>
    <div className="overview-heading"><div><h2><Boxes size={21} /> {filtered ? "Inventario filtrado" : "Inventario actual"}</h2><p>Existencias guardadas · Facto y catálogo · independiente del período de ventas</p></div>
      <Link className="overview-icon" to={copilot} aria-label="Consultar inventario en Copiloto" title="Consultar inventario en Copiloto"><Sparkles size={19} /></Link></div>
    {error && <p className="overview-warning" role="alert">{error}</p>}
    {totals && totals.by_currency.length > 1 && <label className="inventory-currency">Moneda<select aria-label="Moneda de valorización" value={code} onChange={e => setCurrency(e.target.value)}>{totals.by_currency.map(v => <option key={v.currency}>{v.currency}</option>)}</select></label>}
    <dl className="inventory-totals">
      <div><dt>Inventario a costo{conditional ? " referencial" : " registrado"}</dt><dd>{busy ? "Cargando…" : money(values?.cost_reference, code)}</dd><small>{conditional ? `Supone ${code} para ${number(values?.conditional_cost_products)} SKU con moneda pendiente` : `Costo informado · ${code}`}</small></div>
      <div><dt>Unidades disponibles</dt><dd>{busy ? "Cargando…" : number(totals?.available_units)}</dd><small>{number(totals?.available_products)} SKU con stock · {number(totals?.matched_products)} SKU en el filtro</small></div>
      <div><dt>Valor potencial de venta neto</dt><dd>{busy ? "Cargando…" : money(values?.net_sale_value, code)}</dd><small>Sin IVA · {code} · no son ventas realizadas</small></div>
    </dl>
    {conditional && <p className="inventory-coverage">Costo con moneda confirmada: {money(values?.cost_verified, code)}. Parte condicional: {money(values?.cost_conditional, code)}.</p>}
    {totals && <p className="inventory-coverage">{number(totals.unknown_stock_products)} SKU sin stock confirmado · {number(totals.missing_cost_products)} con stock sin costo valorizable · {number(totals.missing_price_products)} con stock sin precio</p>}
    <details className="inventory-detail" open={filtered || undefined}>
      <summary><span>Detalle y filtros de inventario</span><ChevronDown size={18} /></summary>
      <form className="inventory-filters" onSubmit={search}>
        <label>Producto o SKU<div className="inventory-search"><input aria-label="Producto o SKU del inventario" value={draft} onChange={e => setDraft(e.target.value)} maxLength={160} /><button className="overview-icon" title="Buscar inventario" aria-label="Buscar inventario" type="submit"><Search size={18} /></button></div></label>
        <label>Marca<select aria-label="Marca del inventario" value={brand} onChange={e => update("brand", e.target.value)}><option value="">Todas</option>{[...new Set([...(data?.available_brands || []), ...(brand ? [brand] : [])])].map(b => <option key={b}>{b}</option>)}</select></label>
        <label>Stock<select aria-label="Estado del inventario" value={stock} onChange={e => update("stock_filter", e.target.value)}><option value="all">Todos</option><option value="available">Con stock</option><option value="zero">Stock cero</option><option value="unknown">Por verificar</option><option value="low">Stock bajo</option><option value="without_movement">Sin movimiento observado</option><option value="without_cost">Costo por confirmar</option></select></label>
        {stock === "low" && <label>Menos de<input aria-label="Umbral de stock bajo" type="number" min="0" max="1000000" value={threshold} onChange={e => update("threshold", e.target.value || "0")} /></label>}
        {(data?.available_lists.length || 0) > 1 && <label>Lista Facto<select aria-label="Lista de venta del inventario" value={list} onChange={e => update("list_id", e.target.value)}><option value="">Seleccionar lista</option>{data?.available_lists.map(l => <option key={l}>{l}</option>)}</select></label>}
        {filtered && <button type="button" className="overview-icon" title="Quitar filtros de inventario" aria-label="Quitar filtros de inventario" onClick={clear}><X size={18} /></button>}
      </form>
      {!busy && data && !data.records.length && <p className="inventory-coverage">Sin productos para estos filtros.</p>}
      {!!data?.records.length && <div className="inventory-table-scroll"><table><caption>Productos del inventario</caption><thead><tr><th>Producto / SKU</th><th>Unidades</th><th>Costo unitario</th><th>Total a costo</th><th>Precio neto</th><th>Total venta neta</th></tr></thead><tbody>{data.records.map(row => <tr key={row.sku}>
        <td><strong>{row.name}</strong><small>{row.sku} · {row.brand}</small><small>Stock: {date(row.stock_updated_at)}</small></td><td>{number(row.stock)}</td>
        <td>{money(row.unit_cost, row.cost_currency || row.assumed_cost_currency || null)}<small>{row.assumed_cost_currency ? "Moneda supuesta" : row.cost_currency || "Moneda por confirmar"}</small><small>{date(row.cost_updated_at)}</small></td>
        <td>{money(row.cost_reference_value, row.cost_currency || row.assumed_cost_currency || null)}<small>{row.assumed_cost_currency ? "Referencial" : "Registrado"}</small></td>
        <td>{money(row.net_price, row.price_currency)}<small>{date(row.price_updated_at)}</small></td><td>{money(row.net_sale_value, row.price_currency)}</td>
      </tr>)}</tbody></table></div>}
      <nav className="inventory-pagination" aria-label="Paginación del inventario"><button className="overview-icon" type="button" title="Página anterior del inventario" aria-label="Página anterior del inventario" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}><ChevronLeft size={18} /></button><span>{data?.records.length ? `${offset + 1}–${offset + data.records.length}` : "0"} de {number(totals?.matched_products)}</span><button className="overview-icon" type="button" title="Página siguiente del inventario" aria-label="Página siguiente del inventario" disabled={busy || result?.coverage.nextOffset == null} onClick={() => setOffset(result?.coverage.nextOffset || 0)}><ChevronRight size={18} /></button></nav>
      {!!result?.warnings.length && <ul className="inventory-notes">{result.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
    </details>
    <p className="inventory-coverage">Fuentes: {date(data?.source_dates.oldest)} a {date(data?.source_dates.newest)}. No es caja ni costo de ventas.</p>
  </section>;
}
