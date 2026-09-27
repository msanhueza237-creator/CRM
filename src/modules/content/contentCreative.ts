import type { ContentCreativeLayout, ContentProduct, ContentPublication, ContentVisualStyle } from "../../types/content";

export const creativeStyles = [
  { id: "technical", label: "Ficha técnica", accent: "#087e87" },
  { id: "editorial", label: "Protagonista", accent: "#164c43" },
  { id: "industrial", label: "Industrial", accent: "#c33f2d" },
  { id: "laboratory", label: "Laboratorio", accent: "#ddc272" },
  { id: "promotion", label: "Oferta", accent: "#c33f2d" },
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
  if (!clean) return 0;
  let fontSize = size;
  let lines: string[] = [];
  // Fit the entire text region instead of cutting product names off with an ellipsis.
  while (fontSize >= 12) {
    ctx.font = `${weight} ${fontSize}px ${family}`;
    if (fontSize > 12 && clean.split(/\s+/).some((word) => ctx.measureText(word).width > box.w)) { fontSize -= 1; continue; }
    lines = wrap(ctx, clean, box.w);
    if (lines.length * fontSize * 1.16 <= box.h || fontSize === 12) break;
    fontSize -= 1;
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  ctx.fillStyle = color;
  lines.forEach((line, i) => ctx.fillText(line, box.x, box.y + i * fontSize * 1.16));
  ctx.restore();
  return lines.length * fontSize * 1.16;
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
  rule(ctx, x, y + 3, 8, accent, 62);
  text(ctx, "CLIMACTIVA", { x: x + 24, y, w: 390, h: 49 }, 42, color, 900, DISPLAY);
  text(ctx, "CLIMATIZACIÓN PROFESIONAL", { x: x + 25, y: y + 49, w: 390, h: 24 }, 18, color, 700);
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
  return text(d.ctx, d.layout.headline || d.product.name, box, size, color, 900, DISPLAY);
}
function footer(ctx: Context, y = 1013, color = INK, lineColor = "#ccd8d9") {
  rule(ctx, 56, y - 19, 968, lineColor, 2);
  text(ctx, "ASESORÍA Y EQUIPAMIENTO", { x: 56, y, w: 570, h: 36 }, 23, color, 700);
  text(ctx, "climactiva.cl", { x: 766, y: y - 4, w: 258, h: 44 }, 33, color, 800);
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
    rule(d.ctx, x, y + i * gap, 32, accent, 4);
    label(d.ctx, fact.name, x, y + 17 + i * gap, w, accent);
    text(d.ctx, fact.value, { x, y: y + 53 + i * gap, w, h: gap - 65 }, 36, color, 700);
  });
}
function technical(d: Drawing) {
  const { ctx, layout } = d;
  fill(ctx, PAPER); fill(ctx, TEAL, 0, 0, SIZE, 140);
  brand(ctx, 56, 34, PAPER, "#bde5d8");
  text(ctx, layout.badge || "FICHA TÉCNICA", { x: 708, y: 51, w: 316, h: 58 }, 29, PAPER, 700, MONO);
  const headlineHeight = title(d, { x: 56, y: 179, w: 968, h: 203 }, 76);
  const photoTop = Math.max(300, 179 + headlineHeight + 34), photoHeight = 887 - photoTop;
  photo(d, { x: 42, y: photoTop, w: 650, h: photoHeight });
  fill(ctx, "#eff5f3", 728, photoTop, 352, photoHeight);
  rule(ctx, 728, photoTop, 352, TEAL, 7);
  factColumn(d, 756, photoTop + 28, 268, INK, TEAL, Math.min(175, (photoHeight - 28) / 3));
  rule(ctx, 56, 909, 94, "#c33f2d", 7);
  text(ctx, layout.supporting_text, { x: 174, y: 904, w: 850, h: 77 }, 31, MUTED);
  footer(ctx);
}
function editorial(d: Drawing) {
  const { ctx, layout } = d;
  const green = "#164c43", lime = "#dceda0";
  fill(ctx, PAPER); brand(ctx, 56, 34, INK, green);
  text(ctx, cleanCreativeText(d.product.brand) || "EQUIPAMIENTO", { x: 733, y: 49, w: 291, h: 54 }, 26, green, 700, MONO);
  photo(d, { x: 65, y: 126, w: 950, h: 546 });
  rule(ctx, 0, 170, 16, green, 450);
  fill(ctx, green, 0, 698, SIZE, 382);
  fill(ctx, lime, 56, 675, 116, 10);
  text(ctx, layout.badge || d.product.sku || "CLIMACTIVA", { x: 56, y: 724, w: 968, h: 36 }, 25, lime, 700, MONO);
  title(d, { x: 56, y: 771, w: 968, h: 158 }, 74, PAPER);
  text(ctx, layout.supporting_text, { x: 56, y: 946, w: 968, h: 65 }, 29, "#e1ece6");
  text(ctx, "climactiva.cl", { x: 766, y: 1029, w: 258, h: 39 }, 31, PAPER, 800);
  rule(ctx, 56, 1045, 112, lime, 5);
}
function industrial(d: Drawing) {
  const { ctx, layout } = d;
  const red = "#c33f2d", charcoal = "#242827";
  fill(ctx, PAPER); fill(ctx, red, 0, 0, SIZE, 385);
  brand(ctx, 56, 34, PAPER, "#ffbdac");
  label(ctx, "EQUIPO PROFESIONAL", 676, 58, 348, PAPER);
  title(d, { x: 56, y: 155, w: 968, h: 205 }, 76, PAPER);
  photo(d, { x: 56, y: 411, w: 968, h: 463 });
  rule(ctx, 0, 423, 16, red, 404);
  fill(ctx, charcoal, 0, 906, SIZE, 174);
  label(ctx, "REFERENCIA", 56, 925, 324, "#ffb5a6");
  text(ctx, layout.badge || d.product.sku || "CLIMACTIVA", { x: 56, y: 967, w: 324, h: 71 }, 51, PAPER, 900, DISPLAY);
  rule(ctx, 407, 933, 3, "#747b76", 103);
  text(ctx, layout.supporting_text, { x: 442, y: 933, w: 582, h: 86 }, 29, PAPER);
  text(ctx, "climactiva.cl", { x: 766, y: 1034, w: 258, h: 38 }, 30, PAPER, 800);
  rule(ctx, 56, 887, 130, red, 7);
}
function laboratory(d: Drawing) {
  const { ctx, layout } = d;
  const gold = "#ddc272";
  fill(ctx, "#202927");
  ctx.strokeStyle = "#2d3833"; ctx.lineWidth = 1;
  for (let i = 24; i < SIZE; i += 48) { ctx.beginPath(); ctx.moveTo(i, 140); ctx.lineTo(i, 886); ctx.moveTo(0, i); ctx.lineTo(SIZE, i); ctx.stroke(); }
  fill(ctx, "#202927", 0, 0, SIZE, 135);
  brand(ctx, 56, 34, PAPER, gold);
  text(ctx, layout.badge || "CATÁLOGO TÉCNICO", { x: 686, y: 49, w: 338, h: 55 }, 29, gold, 700, MONO);
  rule(ctx, 56, 133, 968, "#52604e", 2);
  const headlineHeight = title(d, { x: 56, y: 166, w: 968, h: 204 }, 74, PAPER);
  const photoTop = Math.max(304, 166 + headlineHeight + 40), photoHeight = 848 - photoTop;
  factColumn(d, 56, photoTop, 285, PAPER, gold, Math.min(175, photoHeight / 3));
  photo(d, { x: 392, y: photoTop, w: 616, h: photoHeight });
  // Registration corners frame the real photo without drawing over the product.
  for (const [x, y, dx, dy] of [[380, photoTop - 12, 1, 1], [1020, photoTop - 12, -1, 1], [380, 860, 1, -1], [1020, 860, -1, -1]]) {
    ctx.strokeStyle = gold; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x, y + dy * 36); ctx.lineTo(x, y); ctx.lineTo(x + dx * 36, y); ctx.stroke();
  }
  fill(ctx, "#202927", 0, 894, SIZE, 186);
  rule(ctx, 56, 901, 72, gold, 5);
  text(ctx, layout.supporting_text, { x: 152, y: 895, w: 872, h: 86 }, 31, "#e0e5da");
  footer(ctx, 1013, PAPER, "#52604e");
}
function promotion(d: Drawing) {
  const { ctx, layout } = d;
  const red = "#c33f2d";
  fill(ctx, PAPER); brand(ctx, 56, 34);
  rule(ctx, 756, 61, 324, red, 12);
  const headlineHeight = title(d, { x: 56, y: 170, w: 968, h: 203 }, 76);
  const photoTop = Math.max(294, 170 + headlineHeight + 34), priceTop = photoTop + 36;
  photo(d, { x: 42, y: photoTop, w: 623, h: 882 - photoTop });
  fill(ctx, red, 693, priceTop, 387, 274);
  label(ctx, /^\$/.test(layout.badge.trim()) ? "PRECIO PUBLICADO" : "DATO DESTACADO", 723, priceTop + 30, 301, PAPER);
  text(ctx, layout.badge || d.product.sku || "CLIMACTIVA", { x: 723, y: priceTop + 88, w: 301, h: 149 }, 78, PAPER, 900, DISPLAY);
  if (d.product.sku) {
    label(ctx, "MODELO / SKU", 723, priceTop + 312, 301, TEAL);
    text(ctx, d.product.sku, { x: 723, y: priceTop + 354, w: 301, h: 89 }, 39, INK, 800);
  }
  fill(ctx, "#eff5f3", 0, 909, SIZE, 82);
  text(ctx, layout.supporting_text, { x: 56, y: 920, w: 968, h: 60 }, 29, MUTED);
  footer(ctx, 1015);
}
function loadImage(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob); const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("La imagen principal no se pudo procesar.")); };
    image.src = url;
  });
}
