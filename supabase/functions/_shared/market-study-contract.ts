export type MarketUnit = "unit" | "kg" | "m" | "l";
export interface MarketFx { currency: string; clp_per_unit: number; observed_at: string; source: string }
export interface MarketObservation {
  provider: string; external_id: string; revision: number; product_label: string; suggested_sku: string | null;
  seller: string; seller_kind: "competitor" | "supplier"; amount: number | null; currency: string | null;
  vat_basis: "net" | "gross" | "exempt" | "unknown"; vat_percent: number | null;
  unit: MarketUnit; package_quantity: number; presentation: string;
  availability: "available" | "unavailable" | "unknown"; source_url: string; observed_at: string;
  confidence: number; fx: MarketFx | null; notes: string;
}
export interface StoredMarketObservation { id: string; payload: MarketObservation; created_at: string; created_by: string }
export interface MarketReviewInput {
  observation_id: string; request_id: string; expected_review_id: string | null;
  decision: "approved" | "rejected" | "pending"; product_key: string; sku: string;
  unit: MarketUnit | null; internal_quantity: number | null; equivalence_confirmed: boolean; cost_basis_confirmed: boolean;
  internal_fx: MarketFx | null; reason: string;
}
export interface MarketReview { id: string; observation_id: string; payload: MarketReviewInput; created_at: string; created_by: string }
export const MARKET_UNITS: MarketUnit[] = ["unit", "kg", "m", "l"];
export const MARKET_SCHEMA_VERSION = 1;
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Se esperaba un objeto JSON.");
  return v as Record<string, unknown>;
};
function text(v: unknown, name: string, max = 200, required = true) {
  if (v == null && !required) return "";
  if (typeof v !== "string" || v.length > max || (required && !v.trim())) throw new Error(`${name}: texto obligatorio de hasta ${max} caracteres.`);
  return v.trim();
}
function num(v: unknown, name: string, min: number, max: number, nullable = false): number | null {
  if (v === null && nullable) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new Error(`${name}: número entre ${min} y ${max}${nullable ? " o null" : ""}.`);
  return v;
}
function choice<T extends string>(v: unknown, values: readonly T[], name: string): T {
  if (!values.includes(v as T)) throw new Error(`${name}: valor no admitido.`);
  return v as T;
}
export function marketDate(v: unknown, name: string, now = Date.now()) {
  const t = text(v, name, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(t) || !Number.isFinite(Date.parse(t)) || Date.parse(t) > now) throw new Error(`${name}: fecha ISO con zona, válida y no futura.`);
  const calendar = t.slice(0,10);
  if (new Date(calendar).toISOString().slice(0,10) !== calendar) throw new Error(`${name}: fecha inexistente.`);
  return new Date(t).toISOString();
}
export function marketUrl(v: unknown) {
  const value = text(v, "URL", 1500), url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("URL HTTP(S) sin credenciales requerida.");
  return url.toString(); // Never fetched by this module; research text is untrusted data.
}
function currency(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) throw new Error("Moneda ISO de tres letras o null.");
  return v;
}
export function marketFx(v: unknown, now = Date.now()): MarketFx | null {
  if (v === null) return null;
  const r = object(v), code = currency(r.currency);
  if (!code || code === "CLP") throw new Error("Tipo de cambio: indicar moneda extranjera.");
  return {currency: code, clp_per_unit: num(r.clp_per_unit,"Cambio CLP",0.000001,1e8)!, observed_at:marketDate(r.observed_at,"Fecha del cambio",now),source:text(r.source,"Fuente del cambio",500)};
}
function uuid(v: unknown, name: string) {
  const value = text(v,name,36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name}: UUID requerido.`);
  return value;
}
export function normalizeMarketObservation(value: unknown, now = Date.now()): MarketObservation {
  const r = object(value);
  const allowed = new Set(["provider","external_id","revision","product_label","suggested_sku","seller","seller_kind","amount","currency","vat_basis","vat_percent","unit","package_quantity","presentation","availability","source_url","observed_at","confidence","fx","notes"]);
  if (Object.keys(r).some(k=>!allowed.has(k))) throw new Error("Campo no admitido. La investigación no puede asignar permisos ni aprobar equivalencias.");
  const revision = num(r.revision,"Revisión",1,1000000)!;
  if (!Number.isInteger(revision)) throw new Error("Revisión entera requerida.");
  const fx = marketFx(r.fx ?? null,now), code = currency(r.currency);
  if (fx && fx.currency !== code) throw new Error("La moneda del cambio no coincide con la oferta.");
  const vat = choice(r.vat_basis,["net","gross","exempt","unknown"],"Base IVA");
  const rate = num(r.vat_percent,"IVA %",0,100,true);
  if (vat === "gross" && rate === null) throw new Error("Precio con IVA: falta tasa explícita.");
  if (vat === "exempt" && rate !== 0) throw new Error("Exento requiere tasa cero explícita.");
  return {provider:text(r.provider,"Proveedor de investigación",80),external_id:text(r.external_id,"ID externo",120),revision,
    product_label:text(r.product_label,"Producto",300),suggested_sku:r.suggested_sku == null ? null : text(r.suggested_sku,"SKU sugerido",120),
    seller:text(r.seller,"Oferente",200),seller_kind:choice(r.seller_kind,["competitor","supplier"],"Tipo de oferente"),
    amount:num(r.amount,"Precio",0,1e12,true),currency:code,vat_basis:vat,vat_percent:rate,
    unit:choice(r.unit,MARKET_UNITS,"Unidad"),package_quantity:num(r.package_quantity,"Cantidad por presentación",0.000001,1e9)!,
    presentation:text(r.presentation,"Presentación",200),availability:choice(r.availability,["available","unavailable","unknown"],"Disponibilidad"),
    source_url:marketUrl(r.source_url),observed_at:marketDate(r.observed_at,"Fecha observada",now),confidence:num(r.confidence,"Confianza",0,1)!,fx,notes:text(r.notes??"","Notas",2000,false)};
}
export function previewMarketImport(body: unknown, now = Date.now()) {
  const r = object(body);
  if (r.schema_version !== MARKET_SCHEMA_VERSION || !Array.isArray(r.observations) || r.observations.length < 1 || r.observations.length > 200) throw new Error("Formato v1: entre 1 y 200 observaciones.");
  const errors: {row:number;message:string}[] = [], items: MarketObservation[] = [], keys = new Set<string>();
  r.observations.forEach((value,i)=>{try{const p=normalizeMarketObservation(value,now),key=JSON.stringify([p.provider,p.external_id,p.revision]);if(keys.has(key))throw new Error("Clave repetida dentro del lote.");keys.add(key);items.push(p);}catch(e){errors.push({row:i+1,message:e instanceof Error?e.message:"Registro inválido"});}});
  return {items,errors,total:r.observations.length,canImport:errors.length===0};
}
export function normalizeMarketReview(value: unknown, now = Date.now()): MarketReviewInput {
  const r=object(value),decision=choice(r.decision,["approved","rejected","pending"],"Decisión"),reason=text(r.reason,"Motivo",1500);
  if(reason.length<12)throw new Error("Explica la equivalencia o rechazo (mínimo 12 caracteres).");
  const unit=r.unit==null?null:choice(r.unit,MARKET_UNITS,"Unidad interna"),quantity=num(r.internal_quantity,"Unidades base por unidad interna",0.000001,1e9,true);
  if(decision==='approved'&&(r.equivalence_confirmed!==true||unit===null||quantity===null))throw new Error("Confirmar equivalencia, unidad y presentación internas antes de comparar.");
  return {observation_id:uuid(r.observation_id,"Observación"),request_id:uuid(r.request_id,"Solicitud"),expected_review_id:r.expected_review_id==null?null:uuid(r.expected_review_id,"Revisión previa"),decision,
    product_key:text(r.product_key,"Producto interno",200),sku:text(r.sku,"SKU interno",120),unit,internal_quantity:quantity,equivalence_confirmed:r.equivalence_confirmed===true,cost_basis_confirmed:r.cost_basis_confirmed===true,internal_fx:marketFx(r.internal_fx??null,now),reason};
}
export function assertMarketAccess(profile: {role: string; active: boolean} | null) {
  if (!profile || profile.active !== true || profile.role !== "administrador") throw new Error("Solo administradores activos pueden consultar costos e investigar mercado.");
}
