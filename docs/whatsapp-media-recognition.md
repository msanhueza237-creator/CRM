# Imágenes y audios de WhatsApp

Implementación preparada; pendiente de verificación y publicación operativa.

- El asistente valida la conversación, remitente, ventana de atención y consentimiento antes de procesar medios.
- Descarga únicamente el archivo indicado por el identificador de Meta. Solo HTTPS en dominios oficiales de Meta, sin redirecciones; archivos limitados a 5 MB para imágenes y 10 MB para audios.
- Audio: transcripción en español mediante gpt-4o-mini-transcribe.
- Imagen: gpt-4o-mini extrae observación y términos de búsqueda con JSON estructurado. Nunca decide precio, stock, compra ni cotización. Las imágenes ambiguas requieren aclaración.
- El texto interpretado pasa por el buscador del catálogo existente y por las lecturas actuales de Tiendanube. El operador ve la interpretación y la respuesta propuesta en celular y escritorio.
- Esta fase prepara respuestas a consultas de productos; no envía WhatsApp automáticamente ni altera los mensajes originales. Las transcripciones no se guardan como datos originales del cliente para emitir cotizaciones.
- Procesar una consulta repetidamente puede repetir la llamada a OpenAI; no hay caché persistente de medios en esta fase.

Validación del 9 de octubre de 2026: 86 pruebas backend aprobadas, tipos y compilación correctos, navegador 320/390/1280 correcto. Las pruebas usan archivos y respuestas sintéticas, sin mensajes reales. La prueba real con una imagen pública del catálogo recibió HTTP 429, código credit_balance_exhausted, tipo insufficient_quota. No se publicó esta función en producción. Hace falta recargar la cuenta API existente y verificar imagen y audio con el proveedor real antes de publicar. No se cambiaron credenciales ni facturación.
