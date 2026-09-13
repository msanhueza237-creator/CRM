import type { ProspectCandidate } from "../../types/crm";

export const DEFAULT_PROSPECTING_KEYWORDS = [
  "tiendas y locales comerciales de aire acondicionado",
  "tiendas y locales comerciales de refrigeracion",
  "distribuidores de productos de climatizacion y refrigeracion",
  "empresas de servicios de aire acondicionado",
  "mantencion y mantenimiento de sistemas de climatizacion y refrigeracion",
  "reparacion de sistemas de climatizacion y refrigeracion",
  "instalacion de sistemas de climatizacion y refrigeracion",
  "empresas de climatizacion y refrigeracion residencial",
  "empresas de climatizacion y refrigeracion comercial",
  "empresas de climatizacion y refrigeracion industrial",
  "contratistas de grandes proyectos de climatizacion y refrigeracion",
];

export const CLIMACTIVA_PROSPECTING_OBJECTIVE = "Encontrar empresas en Chile, dentro de las comunas seleccionadas, "
  + "exclusivamente del rubro de climatizacion, refrigeracion y aire acondicionado residencial, comercial o industrial, "
  + "para establecer una relacion comercial con Climactiva: tiendas, locales y distribuidores que puedan revender nuestros productos, "
  + "y empresas de servicios, mantencion, mantenimiento, reparacion e instalacion de aire acondicionado, climatizacion y refrigeracion "
  + "que puedan utilizarlos en trabajos y proyectos residenciales, comerciales o industriales. "
  + "Incluir contratistas de grandes proyectos cuando exista evidencia; las empresas de servicios no necesitan tener tienda. "
  + "Reunir informacion publica comprobable de la misma empresa: actividad, servicios, segmentos, sitio oficial, telefono, email "
  + "y domicilio para preparar contacto y visita comercial a terreno. Excluir tiendas y servicios de otros rubros, aunque coincidan "
  + "con palabras genericas como distribucion, mantencion o reparacion. No inventar contactos, capacidad de compra ni escala de proyectos.";

const normalized = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const host = (url: string) => {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.hostname.replace(/^www\./, "") : ""; }
  catch { return ""; }
};

export function buildCommercialBrief(candidate: ProspectCandidate) {
  const domain = host(candidate.website);
  const activity = candidate.evidence.filter(e => e.source === "official_website"
    && ["description", "business_line"].includes(e.field)
    && normalized(e.value.trim()) === normalized(candidate.businessLine.trim())
    && domain && host(e.url) === domain);
  // Do not turn explicitly excluded services into a commercial opportunity.
  const text = normalized(activity.map(e => e.value).join(" ")).split(/[.!?;\n]/)
    .filter(fragment => !/\b(no|excepto|excluimos|dejamos de)\b/.test(fragment)).join(". ");
  const approaches: string[] = [];
  if (/\b(tiendas?|local(?:es)? comercial(?:es)?|distribuidor(?:es)?|mayoristas?|venta|comercializacion)\b/.test(text))
    approaches.push("Distribución y reventa de productos");
  if (/\b(servicios?|mantencion|mantenimiento|reparacion|instalacion(?:es)?|instaladores?|contratistas?|proyectos?)\b/.test(text))
    approaches.push("Suministro para servicios y proyectos");
  const segments = [
    ["Residencial", /\b(residencial(?:es)?|viviendas?|hogares?)\b/],
    ["Comercial", /\b(?:climatizacion|refrigeracion|aire acondicionado|sector|segmento|proyectos?|sistemas?|instalaciones?|clientes?)\s+(?:de uso\s+)?comercial(?:es)?\b|\bpara (?:comercios|locales comerciales)\b/],
    ["Industrial", /\bindustrial(?:es)?\b/],
  ] as const;
  return {
    approaches,
    segments: segments.filter(([, pattern]) => pattern.test(text)).map(([label]) => label),
    activity,
  };
}
