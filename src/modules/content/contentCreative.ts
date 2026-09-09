import type { ContentCreativeLayout, ContentProduct, ContentPublication, ContentVisualStyle } from "../../types/content";

export const creativeStyles = [
  { id: "technical", label: "Ficha técnica", accent: "#087e87" },
  { id: "editorial", label: "Protagonista", accent: "#164c43" },
  { id: "industrial", label: "Industrial", accent: "#c64531" },
  { id: "laboratory", label: "Laboratorio", accent: "#ddc272" },
  { id: "promotion", label: "Oferta", accent: "#c64531" },
] as const;
const SIZE = 1080, INK = "#182b30", TEAL = "#087e87", MUTED = "#50676c", PAPER = "#ffffff";
const DISPLAY = '"Arial Black", "Arial", sans-serif', BODY = '"Arial", sans-serif', MONO = '"Consolas", "Courier New", monospace';
type Context = CanvasRenderingContext2D;
type Box = { x: number; y: number; w: number; h: number };
type Drawing = { ctx: Context; image: HTMLImageElement; imageBounds: Box; layout: ContentCreativeLayout; product: ContentProduct };

export function cleanCreativeText(value: unknown) {
  let text = String(value || "");
  if (typeof document !== "undefined") {
    const decoder = document.createElement("textarea");
    for (let i = 0; i < 2; i++) { decoder.innerHTML = text; text = decoder.value; }
  }
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
export function defaultCreativeLayout(product?: ContentProduct, style: ContentVisualStyle = "technical"): ContentCreativeLayout {
  const price = product?.promotional_price ?? product?.price;
  const sourceLines = (product?.description_text || "").split(/\r?\n/).map(cleanCreativeText).filter(Boolean);
  const sourceHeading = sourceLines[0] || "";
  const headline = sourceHeading.length >= 15 && sourceHeading.length <= 100 && !/[.!?:]$/.test(sourceHeading)
    ? sourceHeading : cleanCreativeText(product?.name || "Producto CLIMACTIVA");
  const description = sourceLines.slice(headline === sourceHeading ? 1 : 0)
    .filter((line) => !/^(?:modelo(?:\s*\/\s*sku)?|sku|marca)\s*:/i.test(line)
      && !/^(?:descripci[oó]n general|caracter[ií]sticas destacadas|especificaciones t[eé]cnicas)\s*:?$/i.test(line)).join(" ");
  const sentences = description.split(/(?<=[.!?])\s+/).map((line) => line.replace(/^Características destacadas\s*[:·]?\s*/i, "")).filter((line) => line.length > 25);
  const usable = sentences.filter((line) => line.length <= 200 && !/^(?:[¡¿]?\s*(?:descubre|conoce|compra|no dejes|por qu[eé])|SKU\s*:)/i.test(line));
  const short = usable.find((line) => /permite|fabricad|compatible|operaci[oó]n|caudal|capacidad|conexi[oó]n/i.test(line))
    || usable[0] || sentences.find((line) => line.length <= 200) || description.slice(0, 200).replace(/\s+\S*$/, "");
  return {
    style,
    headline: headline.slice(0, 120),
    supporting_text: short,
    badge: style === "promotion" && typeof price === "number" && price > 0
      ? new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(price)
      : cleanCreativeText(product?.sku || "").slice(0, 80),
    website: "climactiva.cl",
  };
}
export async function renderContentCreative(input: {
  imageBlob: Blob; layout: ContentCreativeLayout; product: ContentProduct;
  publication?: ContentPublication; slideIndex?: number; slideCount?: number;
}) {
  if (input.layout.style === "original") throw new Error("El estilo original no requiere composición gráfica.");
  const image = await loadImage(input.imageBlob);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Este navegador no permite crear la pieza visual.");
  ctx.textBaseline = "top";
  const drawing = { ctx, image, imageBounds: productPhotoBounds(image), layout: input.layout, product: input.product };
  const renderers = { technical, editorial, industrial, laboratory, promotion };
  const renderer = renderers[input.layout.style];
  if (!renderer) throw new Error("El diseño seleccionado no está disponible.");
  renderer(drawing);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("No se pudo exportar la pieza visual.")), "image/jpeg", 0.95,
  ));
}
function fill(ctx: Context, color: string, x = 0, y = 0, w = SIZE, h = SIZE) {
  ctx.fillStyle = color; ctx.fillRect(x, y, w, h);
}
function text(ctx: Context, value: string, box: Box, size = 30, color = INK, weight = 500, family = BODY) {
  const clean = cleanCreativeText(value);
  if (!clean) return;
  let fontSize = size;
  let lines: string[] = [];
  // Fit the entire text region instead of cutting product names off with an ellipsis.
  while (fontSize >= 12) {
    ctx.font = `${weight} ${fontSize}px ${family}`;
    if (fontSize > 12 && clean.split(/\s+/).some((word) => ctx.measureText(word).width > box.w)) { fontSize -= 1; continue; }
    lines = wrap(ctx, clean, box.w);
    if (lines.length * fontSize * 1.16 <= box.h) break;
    fontSize -= 1;
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  ctx.fillStyle = color;
  lines.forEach((line, i) => ctx.fillText(line, box.x, box.y + i * fontSize * 1.16));
  ctx.restore();
}
function wrap(ctx: Context, value: string, width: number) {
  const lines: string[] = []; let line = "";
  for (const word of value.split(/\s+/)) {
    if (ctx.measureText(line ? `${line} ${word}` : word).width <= width) { line = line ? `${line} ${word}` : word; continue; }
    if (line) lines.push(line);
    line = "";
    for (const letter of word) {
      if (ctx.measureText(line + letter).width > width && line) { lines.push(line); line = ""; }
      line += letter;
    }
  }
  if (line) lines.push(line);
  return lines;
}
function rule(ctx: Context, x: number, y: number, w: number, color = TEAL, h = 3) { fill(ctx, color, x, y, w, h); }
function label(ctx: Context, value: string, x: number, y: number, w = 700, color = TEAL) {
  text(ctx, value.toUpperCase(), { x, y, w, h: 32 }, 23, color, 700, MONO);
}
function brand(ctx: Context, x = 56, y = 42, color = INK, accent = TEAL) {
  rule(ctx, x, y + 2, 8, accent, 51);
  text(ctx, "CLIMACTIVA", { x: x + 22, y, w: 335, h: 39 }, 34, color, 900, DISPLAY);
  text(ctx, "CLIMATIZACIÓN PROFESIONAL", { x: x + 23, y: y + 39, w: 350, h: 24 }, 16, color, 700);
}
function photo({ ctx, image, imageBounds }: Drawing, box: Box) {
  fill(ctx, PAPER, box.x, box.y, box.w, box.h);
  const scale = Math.min(box.w / imageBounds.w, box.h / imageBounds.h);
  const w = imageBounds.w * scale, h = imageBounds.h * scale;
  ctx.drawImage(image, imageBounds.x, imageBounds.y, imageBounds.w, imageBounds.h, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
}
function productPhotoBounds(image: HTMLImageElement): Box {
  const full = { x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight };
  const scale = Math.min(1, 320 / Math.max(full.w, full.h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(full.w * scale)); canvas.height = Math.max(1, Math.round(full.h * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return full;
  fill(ctx, PAPER, 0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const marked = (x: number, y: number) => { const index = (y * canvas.width + x) * 4; return Math.min(data[index], data[index + 1], data[index + 2]) < 248; };
  // Fit only the empty white/transparent surround; keep contextual photographs intact.
  for (let x = 0; x < canvas.width; x++) if (marked(x, 0) || marked(x, canvas.height - 1)) return full;
  for (let y = 0; y < canvas.height; y++) if (marked(0, y) || marked(canvas.width - 1, y)) return full;
  let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (marked(x, y)) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) return full;
  const padding = Math.max(5, Math.max(right - left, bottom - top) * .08);
  const x = Math.max(0, left - padding), y = Math.max(0, top - padding);
  return { x: x * full.w / canvas.width, y: y * full.h / canvas.height,
    w: (Math.min(canvas.width, right + padding + 1) - x) * full.w / canvas.width,
    h: (Math.min(canvas.height, bottom + padding + 1) - y) * full.h / canvas.height };
}
function title(d: Drawing, box: Box, size = 68, color = INK) {
  text(d.ctx, d.layout.headline || d.product.name, box, size, color, 900, DISPLAY);
}
function footer(ctx: Context, y = 1005, color = INK, lineColor = "#ccd8d9") {
  rule(ctx, 56, y - 20, 968, lineColor, 2);
  text(ctx, "ASESORÍA Y EQUIPAMIENTO", { x: 56, y, w: 550, h: 37 }, 23, color, 700);
  text(ctx, "climactiva.cl", { x: 750, y: y - 4, w: 274, h: 44 }, 32, color, 800);
}
export function getCreativeFacts(product: ContentProduct) {
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const lines = (product.description_text || "").split(/\r?\n/).map(cleanCreativeText).filter(Boolean);
  const table = lines.findIndex((line, i) => normalize(line) === "parametro" && normalize(lines[i + 1] || "") === "detalle tecnico");
  const specs: Array<{ name: string; value: string }> = [];
  // Only paired cells from the explicit catalog specification table, never inferred measurements.
  if (table >= 0) for (let i = table + 2; i + 1 < lines.length; i += 2) {
    const name = lines[i], value = lines[i + 1];
    if (!/modelo|alternativ|referencia/.test(normalize(name)) && name.length <= 65 && value.length <= 140) specs.push({ name, value });
  }
  const fallback = [["MARCA", product.brand], ["CATEGORÍA", product.category]]
    .filter((pair) => cleanCreativeText(pair[1])).map(([name, value]) => ({ name: name!, value: cleanCreativeText(value) }));
  return [...(product.sku ? [{ name: "MODELO / SKU", value: cleanCreativeText(product.sku) }] : []), ...specs, ...fallback].slice(0, 3);
}
function factColumn(d: Drawing, x: number, y: number, w: number, color = INK, accent = TEAL, gap = 143) {
  getCreativeFacts(d.product).forEach((fact, i) => {
    label(d.ctx, fact.name, x, y + i * gap, w, accent);
    text(d.ctx, fact.value, { x, y: y + 36 + i * gap, w, h: gap - 51 }, 33, color, 700);
  });
}
function factStrip(d: Drawing, y: number, color = INK, accent = TEAL) {
  const items = getCreativeFacts(d.product); const width = 968 / Math.max(1, items.length);
  items.forEach((fact, i) => {
    const x = 56 + i * width;
    label(d.ctx, fact.name, x, y, width - 28, accent);
    text(d.ctx, fact.value, { x, y: y + 37, w: width - 28, h: 82 }, 30, color, 700);
  });
}
function technical(d: Drawing) {
  const { ctx, layout } = d;
  fill(ctx, PAPER); brand(ctx); label(ctx, layout.badge || "FICHA TÉCNICA", 684, 62, 340);
  rule(ctx, 56, 127, 968);
  title(d, { x: 56, y: 154, w: 968, h: 191 }, 65);
  photo(d, { x: 56, y: 365, w: 605, h: 473 });
  fill(ctx, "#eff4f3", 688, 365, 336, 473);
  factColumn(d, 712, 391, 282, INK, TEAL, 145);
  rule(ctx, 56, 862, 72, TEAL, 6);
  text(ctx, layout.supporting_text, { x: 56, y: 888, w: 968, h: 89 }, 31, MUTED);
  footer(ctx);
}
function editorial(d: Drawing) {
  const { ctx, layout } = d;
  fill(ctx, PAPER); brand(ctx, 56, 42, INK, "#164c43");
  label(ctx, cleanCreativeText(d.product.brand) || "EQUIPAMIENTO", 668, 60, 356, "#164c43");
  photo(d, { x: 104, y: 138, w: 872, h: 527 });
  fill(ctx, "#164c43", 0, 690, 1080, 390);
  label(ctx, layout.badge || d.product.sku || "CLIMACTIVA", 56, 724, 968, "#cfe4d5");
  title(d, { x: 56, y: 772, w: 968, h: 172 }, 65, PAPER);
  text(ctx, layout.supporting_text, { x: 56, y: 960, w: 656, h: 82 }, 27, "#dfebe4");
  text(ctx, "climactiva.cl", { x: 754, y: 998, w: 270, h: 46 }, 31, PAPER, 800);
}
function industrial(d: Drawing) {
  const { ctx, layout } = d;
  fill(ctx, PAPER); fill(ctx, "#c64531", 734, 0, 346, 1080);
  brand(ctx, 56, 42); label(ctx, "EQUIPO PROFESIONAL", 56, 148, 624);
  title(d, { x: 56, y: 204, w: 616, h: 220 }, 60);
  photo(d, { x: 35, y: 437, w: 672, h: 528 });
  label(ctx, "REFERENCIA", 771, 60, 274, PAPER);
  text(ctx, layout.badge || d.product.sku || "CLIMACTIVA", { x: 771, y: 110, w: 257, h: 192 }, 65, PAPER, 900, DISPLAY);
  rule(ctx, 771, 330, 253, "#e69a8e", 3);
  text(ctx, layout.supporting_text, { x: 771, y: 368, w: 253, h: 353 }, 33, PAPER);
  if (d.product.brand) { label(ctx, "MARCA", 771, 766, 253, "#fff0e9"); text(ctx, d.product.brand, { x: 771, y: 806, w: 253, h: 116 }, 38, PAPER, 800); }
  text(ctx, "climactiva.cl", { x: 56, y: 1005, w: 616, h: 46 }, 34, INK, 800);
  rule(ctx, 771, 1012, 253, PAPER, 5);
}
function laboratory(d: Drawing) {
  const { ctx, layout } = d;
  const gold = "#ddc272";
  fill(ctx, "#202927");
  ctx.strokeStyle = "#35413b"; ctx.lineWidth = 1;
  for (let i = 24; i < SIZE; i += 48) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, SIZE); ctx.moveTo(0, i); ctx.lineTo(SIZE, i); ctx.stroke(); }
  brand(ctx, 56, 42, PAPER, gold); label(ctx, layout.badge || "CATÁLOGO TÉCNICO", 658, 62, 366, gold);
  title(d, { x: 56, y: 166, w: 450, h: 496 }, 63, PAPER);
  photo(d, { x: 540, y: 178, w: 484, h: 484 });
  rule(ctx, 540, 164, 484, gold, 4); rule(ctx, 540, 673, 484, gold, 4);
  fill(ctx, "#29342f", 40, 711, 1000, 150); factStrip(d, 727, PAPER, gold);
  text(ctx, layout.supporting_text, { x: 56, y: 885, w: 968, h: 91 }, 30, "#e0e5da");
  footer(ctx, 1014, PAPER, "#687260");
}
function promotion(d: Drawing) {
  const { ctx, layout } = d;
  fill(ctx, PAPER); brand(ctx); rule(ctx, 56, 128, 968, "#c64531", 6);
  title(d, { x: 56, y: 162, w: 585, h: 237 }, 59);
  fill(ctx, "#c64531", 681, 159, 343, 241);
  label(ctx, /^\$/.test(layout.badge.trim()) ? "PRECIO PUBLICADO" : "DATO DESTACADO", 705, 183, 294, PAPER);
  text(ctx, layout.badge || d.product.sku || "CLIMACTIVA", { x: 705, y: 236, w: 294, h: 128 }, 65, PAPER, 900, DISPLAY);
  photo(d, { x: 118, y: 417, w: 844, h: 340 });
  text(ctx, layout.supporting_text, { x: 56, y: 773, w: 968, h: 53 }, 27, MUTED);
  fill(ctx, "#eff4f3", 0, 838, 1080, 147); factStrip(d, 858);
  footer(ctx, 1013);
}
function loadImage(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob); const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("La imagen principal no se pudo procesar.")); };
    image.src = url;
  });
}
