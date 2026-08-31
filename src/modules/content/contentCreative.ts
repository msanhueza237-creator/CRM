import type {
  ContentCreativeLayout,
  ContentProduct,
  ContentPublication,
  ContentVisualStyle,
} from "../../types/content";

const CANVAS_SIZE = 1080;

const palettes: Record<Exclude<ContentVisualStyle, "original">, {
  accent: string;
  accentSoft: string;
  background: string;
  footer: string;
  ink: string;
}> = {
  editorial: {
    accent: "#078491",
    accentSoft: "#dff3f2",
    background: "#f4f7f6",
    footer: "#073f48",
    ink: "#172d33",
  },
  technical: {
    accent: "#277867",
    accentSoft: "#dceee7",
    background: "#eef3f1",
    footer: "#193d3d",
    ink: "#173236",
  },
  promotion: {
    accent: "#d44f40",
    accentSoft: "#ffe7df",
    background: "#f6f8f7",
    footer: "#075f6b",
    ink: "#172d33",
  },
};

export function defaultCreativeLayout(
  product?: ContentProduct,
  style: ContentVisualStyle = "editorial",
): ContentCreativeLayout {
  return {
    style,
    headline: product?.name?.trim() || "Producto Climactiva",
    supporting_text: firstUsefulSentence(product?.description_text),
    badge: defaultBadge(product, style),
    website: "climactiva.cl",
  };
}

export async function renderContentCreative(input: {
  imageBlob: Blob;
  layout: ContentCreativeLayout;
  product: ContentProduct;
  publication: ContentPublication;
  slideIndex: number;
  slideCount: number;
}) {
  if (input.layout.style === "original") throw new Error("El estilo original no requiere composición gráfica.");
  const image = await loadImage(input.imageBlob);
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Este navegador no permite crear la pieza visual.");

  const palette = palettes[input.layout.style];
  drawBackground(context, image, palette.background);
  drawBrand(context, palette);
  drawProductImage(context, image, palette);
  drawMessage(context, input.layout, input.product, input.slideIndex, input.slideCount, palette);
  drawFooter(context, input.layout, input.publication, palette);

  return canvasBlob(canvas);
}

function drawBackground(context: CanvasRenderingContext2D, image: HTMLImageElement, background: string) {
  context.fillStyle = background;
  context.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  context.save();
  context.globalAlpha = 0.09;
  context.filter = "blur(18px)";
  drawImageCover(context, image, -40, -40, CANVAS_SIZE + 80, 900);
  context.restore();
  const wash = context.createLinearGradient(0, 0, 730, 0);
  wash.addColorStop(0, "rgba(255,255,255,0.98)");
  wash.addColorStop(0.48, "rgba(255,255,255,0.92)");
  wash.addColorStop(0.72, "rgba(255,255,255,0.30)");
  wash.addColorStop(1, "rgba(255,255,255,0.05)");
  context.fillStyle = wash;
  context.fillRect(0, 0, CANVAS_SIZE, 900);
}

function drawBrand(
  context: CanvasRenderingContext2D,
  palette: (typeof palettes)["editorial"],
) {
  context.fillStyle = palette.accent;
  roundedRect(context, 58, 54, 52, 52, 12);
  context.fill();
  context.strokeStyle = "#ffffff";
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(74, 80);
  context.lineTo(94, 80);
  context.moveTo(84, 70);
  context.lineTo(84, 90);
  context.stroke();

  context.fillStyle = palette.ink;
  context.font = "800 28px Arial, sans-serif";
  context.fillText("CLIMACTIVA", 126, 76);
  context.fillStyle = palette.accent;
  context.font = "700 15px Arial, sans-serif";
  context.fillText("CLIMATIZACIÓN PROFESIONAL", 126, 101);
}

function drawProductImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  palette: (typeof palettes)["editorial"],
) {
  context.save();
  context.shadowColor = "rgba(12,47,54,0.20)";
  context.shadowBlur = 34;
  context.shadowOffsetY = 18;
  context.fillStyle = "rgba(255,255,255,0.96)";
  roundedRect(context, 465, 145, 565, 668, 10);
  context.fill();
  context.restore();

  context.save();
  roundedRect(context, 485, 165, 525, 628, 6);
  context.clip();
  context.fillStyle = "#ffffff";
  context.fillRect(485, 165, 525, 628);
  drawImageContain(context, image, 497, 177, 501, 604);
  context.restore();

  context.fillStyle = palette.accent;
  context.fillRect(465, 813, 565, 8);
}

function drawMessage(
  context: CanvasRenderingContext2D,
  layout: ContentCreativeLayout,
  product: ContentProduct,
  slideIndex: number,
  slideCount: number,
  palette: (typeof palettes)["editorial"],
) {
  const eyebrow = slideCount > 1 && slideIndex > 0
    ? `DETALLE ${slideIndex + 1} DE ${slideCount}`
    : layout.style === "technical"
      ? "SOLUCIÓN TÉCNICA"
      : layout.style === "promotion"
        ? "PRODUCTO DESTACADO"
        : "EQUIPAMIENTO CLIMACTIVA";
  context.fillStyle = palette.accent;
  context.font = "800 18px Arial, sans-serif";
  context.fillText(eyebrow, 62, 190);
  context.fillRect(62, 207, 94, 5);

  const headline = cleanText(layout.headline || product.name).toUpperCase();
  const headlineBlock = fitWrappedText(context, headline, 345, 4, 57, 38, 1.02);
  context.fillStyle = palette.ink;
  context.font = `900 ${headlineBlock.fontSize}px Arial, sans-serif`;
  headlineBlock.lines.forEach((line, index) => {
    context.fillText(line, 62, 275 + index * headlineBlock.lineHeight);
  });

  let nextY = 275 + headlineBlock.lines.length * headlineBlock.lineHeight + 22;
  const badge = cleanText(layout.badge);
  if (badge) {
    context.font = "800 24px Arial, sans-serif";
    const badgeWidth = Math.min(348, context.measureText(badge).width + 34);
    context.fillStyle = palette.accent;
    roundedRect(context, 62, nextY, badgeWidth, 48, 7);
    context.fill();
    context.fillStyle = "#ffffff";
    context.fillText(badge, 79, nextY + 33);
    nextY += 76;
  }

  const supportingText = cleanText(layout.supporting_text || firstUsefulSentence(product.description_text));
  if (supportingText) {
    context.fillStyle = "#3e555a";
    context.font = "500 24px Arial, sans-serif";
    const lines = wrapText(context, supportingText, 345).slice(0, 5);
    lines.forEach((line, index) => context.fillText(line, 62, nextY + index * 34));
  }
}

function drawFooter(
  context: CanvasRenderingContext2D,
  layout: ContentCreativeLayout,
  publication: ContentPublication,
  palette: (typeof palettes)["editorial"],
) {
  context.fillStyle = palette.footer;
  context.fillRect(0, 900, CANVAS_SIZE, 180);
  context.fillStyle = palette.accent;
  context.fillRect(0, 900, 410, 10);
  context.fillStyle = "#ffffff";
  context.font = "800 19px Arial, sans-serif";
  context.fillText("ASESORÍA Y EQUIPAMIENTO", 62, 960);
  context.font = "500 17px Arial, sans-serif";
  context.fillStyle = "#cde5e6";
  context.fillText("Soluciones para climatización profesional", 62, 994);

  context.strokeStyle = "rgba(255,255,255,0.32)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(622, 934);
  context.lineTo(622, 1044);
  context.stroke();
  context.fillStyle = "#ffffff";
  context.font = "800 18px Arial, sans-serif";
  context.fillText("CONOCE MÁS EN", 666, 960);
  context.font = "800 30px Arial, sans-serif";
  context.fillText(cleanWebsite(layout.website), 666, 1003);
  context.font = "500 15px Arial, sans-serif";
  context.fillStyle = "#cde5e6";
  context.fillText(publication.hashtags.includes("Climactiva") ? "#Climactiva" : "Producto verificado", 666, 1032);
}

function drawImageContain(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawImageCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function fitWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
  startSize: number,
  minSize: number,
  lineHeightRatio: number,
) {
  for (let fontSize = startSize; fontSize >= minSize; fontSize -= 2) {
    context.font = `900 ${fontSize}px Arial, sans-serif`;
    const lines = wrapText(context, text, maxWidth);
    if (lines.length <= maxLines) return { lines, fontSize, lineHeight: fontSize * lineHeightRatio };
  }
  context.font = `900 ${minSize}px Arial, sans-serif`;
  const lines = wrapText(context, text, maxWidth).slice(0, maxLines);
  if (lines.length) lines[lines.length - 1] = truncateToWidth(context, lines[lines.length - 1], maxWidth);
  return { lines, fontSize: minSize, lineHeight: minSize * lineHeightRatio };
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = context.measureText(word).width <= maxWidth ? word : truncateToWidth(context, word, maxWidth);
  }
  if (line) lines.push(line);
  return lines;
}

function truncateToWidth(context: CanvasRenderingContext2D, value: string, maxWidth: number) {
  let text = value;
  while (text.length > 1 && context.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return `${text}…`;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

function loadImage(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Una imagen del producto no se pudo procesar."));
    };
    image.src = objectUrl;
  });
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("No se pudo exportar la pieza visual.")), "image/jpeg", 0.92);
  });
}

function firstUsefulSentence(value?: string | null) {
  const text = cleanText(value || "");
  if (!text) return "Conoce sus características y encuentra la solución adecuada para tu proyecto.";
  const sentence = text.split(/(?<=[.!?])\s+/)[0] || text;
  return sentence.length > 155 ? `${sentence.slice(0, 152).trim()}…` : sentence;
}

function defaultBadge(product: ContentProduct | undefined, style: ContentVisualStyle) {
  if (!product) return "";
  if (style === "promotion" && product.promotional_price !== null) {
    return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(product.promotional_price);
  }
  return cleanText(product.sku || product.category || "").slice(0, 28);
}

function cleanText(value: unknown) {
  const source = String(value || "");
  const decoded = typeof document === "undefined"
    ? source
    : (() => {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = source;
      return textarea.value;
    })();
  return decoded.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function cleanWebsite(value: string) {
  return cleanText(value).replace(/^https?:\/\//i, "").replace(/\/+$/, "") || "climactiva.cl";
}
