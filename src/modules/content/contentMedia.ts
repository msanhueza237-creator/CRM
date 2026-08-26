import type { ContentProduct, ContentPublication } from "../../types/content";

const MAX_CAROUSEL_IMAGES = 10;

export function getPublicationMediaUrls(
  publication: ContentPublication,
  product?: ContentProduct,
) {
  const frozenUrls = Array.isArray(publication.source_facts?.media_urls)
    ? publication.source_facts.media_urls
    : [];
  const productUrls = Array.isArray(product?.images)
    ? product.images.map((image) => image?.src)
    : [];
  return normalizeMediaUrls(
    [...frozenUrls, ...productUrls],
    publication.image_url || product?.primary_image_url,
  );
}

export function getProductMediaUrls(product?: ContentProduct) {
  return normalizeMediaUrls(
    product?.images?.map((image) => image?.src) || [],
    product?.primary_image_url,
  );
}

function normalizeMediaUrls(values: unknown[], fallback?: unknown) {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const value of [...values, fallback]) {
    const url = typeof value === "string" ? value.trim() : "";
    if (!/^https:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length === MAX_CAROUSEL_IMAGES) break;
  }
  return urls;
}
