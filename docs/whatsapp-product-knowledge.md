# Conocimiento de productos para WhatsApp

La base principal es `content_products`, sincronizada desde Tiendanube mediante `sync_content_products_from_tiendanube`. No se crea un catálogo paralelo. Conserva nombre, marca, categoría, descripción oficial, URL y variantes (SKU, identificadores y datos comerciales).

Auditoría del 9 de octubre de 2026: 275 productos activos, 275 variantes, 274 descripciones, 265 productos con SKU. Los 10 restantes requieren completar SKU en Tiendanube; no se inventan códigos ni características.

WhatsApp busca en nombre, SKU, descripción, marca y categoría. Conserva números y fracciones, tolera plurales y errores de una letra en palabras largas; las medidas no se aproximan. Incluye la variante lingüística motivada/motirazada como motorizada. Una búsqueda por nombre o características no requiere escribir precio o stock.

Las alternativas siempre se revalidan en la API de Tiendanube antes de mostrar precios, stock y enlaces. Las descripciones oficiales se actualizan con esa misma lectura, se eliminan etiquetas HTML y se muestran como información de la tienda. No se usan instrucciones contenidas en las descripciones para ejecutar acciones. Datos ausentes requieren verificación humana. No garantiza responder preguntas que la ficha no documenta.

La prueba contra el catálogo real encontró los 265 productos con SKU por sus nombres completos, incluyendo nombres largos; la consulta «estoy buscando valvula motivada de 2 vías 3/4» recupera MVA-2W34 y excluye MVA-3W34.
