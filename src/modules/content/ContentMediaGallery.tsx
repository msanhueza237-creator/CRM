import { useState } from "react";

export function ContentMediaGallery({ images, alt }: { images: string[]; alt: string }) {
  const [selectedUrl, setSelectedUrl] = useState("");
  if (!images.length) return null;
  const activeUrl = images.includes(selectedUrl) ? selectedUrl : images[0];
  const selectedIndex = images.indexOf(activeUrl);

  return (
    <section className="content-media-gallery" aria-label={`Galería de ${alt}`}>
      <div className="content-media-primary">
        <img src={activeUrl} alt={`${alt}, imagen ${selectedIndex + 1}`} />
        {images.length > 1 ? <span>{selectedIndex + 1} / {images.length}</span> : null}
      </div>
      {images.length > 1 ? (
        <div className="content-media-thumbnails" aria-label="Imágenes disponibles para el carrusel">
          {images.map((image, index) => (
            <button
              className={image === activeUrl ? "active" : ""}
              type="button"
              key={image}
              onClick={() => setSelectedUrl(image)}
              title={`Ver imagen ${index + 1}`}
              aria-label={`Ver imagen ${index + 1} de ${images.length}`}
              aria-pressed={image === activeUrl}
            >
              <img src={image} alt="" />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
