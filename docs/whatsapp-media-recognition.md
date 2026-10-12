# Imágenes y audios de WhatsApp

## Entrega del 12 de octubre de 2026 — publicación autorizada, verificación en curso

Base: `e639a4a546cd838840b2fa20c665c61e87dc5853`. Las ramas remotas `fix/historical-import-cloud` y `codex/whatsapp-media-recognition` coincidían al iniciar. Se preserva el contexto de imágenes, pedidos múltiples y las mejoras locales de validación/privacidad. El TS18047 de `3b31a3d` ya estaba corregido en la base. No se trabaja sobre `main` antigua.

Marco autorizó explícitamente OpenAI para transcribir y DeepSeek para interpretar. Posteriormente Marco autorizó commit, push, despliegue y pruebas con muestras sintéticas mediante las integraciones existentes. No se autorizan mensajes a clientes ni uso de sus medios privados.

### Flujo y proveedores

1. La recepción de Meta conserva el mensaje original. El operador pulsa **Proponer respuesta** en una conversación autorizada y abierta.
2. Audio: OpenAI `gpt-4o-mini-transcribe`, `POST https://api.openai.com/v1/audio/transcriptions`, español, JSON. Se reutiliza `OPENAI_API_KEY`; no se crean credenciales. No se transmite historial ni catálogo a OpenAI: solo el audio seleccionado.
3. DeepSeek `deepseek-flash`, `POST https://api.deepseek.com/responses`, recibe la transcripción textual filtrada y contexto acotado de esa conversación; no recibe los bytes de audio. Devuelve intención, consultas de productos, cantidades y aclaraciones mediante JSON estructurado. La integración cifrada existente `prospecting_ai_integrations` debe estar verificada, incluir `deepseek-flash` y ser descifrable con la configuración backend existente.
4. Las consultas interpretadas determinan búsquedas en el catálogo y lecturas actuales de Tiendanube. El modelo no fija precios/stock ni tiene herramientas de finanzas. Cantidades no respaldadas por el texto requieren confirmación. Los datos de identidad para cotizaciones deben proceder de mensajes originales escritos; una transcripción no los convierte en datos verificados.
5. La UI explica ambas funciones y distingue **Transcripción · OpenAI** de **Interpretación · DeepSeek**. **Usar propuesta** copia al editor; el envío sigue siendo manual. `canSend:false` se conserva.
6. Fotos mantienen DeepSeek predeterminado y el selector explícito OpenAI ya existente. Elegir OpenAI para fotos NO cambia los proveedores de audio. No hay fallback ni reintentos automáticos. Repetir una propuesta puede repetir las llamadas y su costo; no se agregó caché persistente.

La [referencia oficial de OpenAI](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) documenta `gpt-4o-mini-transcribe`, JSON y formatos incluidos OGG. La [guía de DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/) documenta interpretación textual e imágenes; DeepSeek no se presenta como transcriptor. [Harness Voice input](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/voice-input.md) es una integración distinta con reconocimiento local.

### Límites y errores

- Descarga por ID Meta coincidente, HTTPS en dominios Meta permitidos, sin redirecciones ni URLs suministradas por el cliente.
- Imagen: 5 MiB; JPEG, PNG, WebP. Audio: 10 MiB; OGG, MPEG/MP3, MP4/M4A, WAV y WebM. Se comprueba MIME y firma básica del contenedor. AAC aislado no se acepta ni se renombra como otro formato; no se instaló un conversor.
- Metadatos/proveedor: respuesta máxima 128 KiB. Transcripción no vacía de hasta 4096 caracteres; no se acorta silenciosamente una transcripción válida. El contexto histórico se limita a 40 mensajes y 1500 caracteres por mensaje.
- Errores de configuración/permisos, saldo/cuota, límite temporal, formato y proveedor se identifican por etapa mediante mensajes controlados. No se exponen cuerpos de error, tokens, URLs privadas o detalles de descifrado. Un error no se convierte en texto para enviar al cliente.
- Se conserva el aislamiento de empresa/teléfono/cuenta Meta y sesión conversacional; bajas y ventana cerrada impiden procesar medios, también al preparar cotizaciones.
- Se omiten líneas textuales marcadas como financieras/internas y se redactan correos/teléfonos; continúa la exclusión del texto posterior al RUT. La observación del modelo se limita por prompt a información comercial. Estas reglas NO son anonimización universal del texto ni de los píxeles/voz originales. El envío manual requiere revisión humana.

### Verificación y bloqueo de prueba real

Resultado final local: **256/256 pruebas aprobadas**, typecheck backend y build frontend correctos; `git diff --check` limpio. Navegador con red interceptada en 320/390/1280: proveedores diferenciados, transcripción e interpretación visibles, error de cuota sin botón de usar propuesta y envío manual. Las ramas remotas se comprobaron de nuevo al finalizar y seguían en `e639a4a`. No se realizó commit, push, merge o despliegue.

Las pruebas locales usan muestras generadas y proveedores simulados, incluyendo una prueba en la que OpenAI produce una frase hablada y la interpretación DeepSeek cambia realmente la consulta al catálogo. También prueban errores por etapa, cuota, configuración, formatos, límites, ausencia de fallback, privacidad, conversación ajena y cotización sin identidad inferida de voz.

No hay `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` ni `PROSPECTING_SECRET_ENCRYPTION_KEY` disponibles en el entorno de ejecución local (solo se comprobó presencia, nunca valores). Por ello no se pudo ejecutar una prueba real sintética contra ambos proveedores ni comprobar saldo. No se usaron credenciales de producción ni se solicitó crearlas. Antes de publicar se requiere ejecutar esa comprobación desde un backend autorizado que ya tenga la integración existente.

Comandos locales (sin conexiones reales):

```sh
node --experimental-transform-types --test --test-concurrency=1 scripts/test-whatsapp-audio-pipeline.mjs scripts/test-whatsapp-media-analysis.mjs scripts/test-whatsapp-automation-plan.mjs scripts/test-whatsapp-automation-preview.mjs scripts/test-whatsapp-automation-e2e.mjs scripts/test-whatsapp-quote-context.mjs scripts/test-whatsapp-quote-flow.mjs scripts/test-whatsapp-meta.mjs scripts/test-whatsapp-conversation.mjs scripts/test-direct-messages.mjs scripts/test-whatsapp-inbox.mjs scripts/test-whatsapp-management.mjs scripts/test-whatsapp-delivery.mjs scripts/test-whatsapp-catalog.mjs
node scripts/typecheck-whatsapp.mjs
npm run build
PLAYWRIGHT_BROWSERS_PATH=/tmp/crm-playwright node --experimental-transform-types scripts/test-whatsapp-conversation-browser.mjs
git diff --check
```

### Procedimiento de publicación autorizado

1. Volver a consultar las ramas remotas. En un checkout aislado de la revisión aprobada, ejecutar `git apply --check /workspace/whatsapp-audio-final.patch` y después aplicar el diff; integrar por revisión si la base cambió. No sobrescribir cambios posteriores ni publicar desde `main` antigua.
2. Repetir las comprobaciones anteriores; probar con una muestra de voz sintética en el backend autorizado, confirmar modelo/proveedor de ambas etapas, cuota y permisos sin mostrar secretos. Probar OGG de nota de voz además de WAV; no utilizar medios de clientes.
3. Desplegar en el servicio existente `crm-agent` de `supabase.latinchile.cl` los módulos cambiados `whatsapp-media-analysis.ts`, `whatsapp-image-context.ts`, `whatsapp-automation-preview.ts` y `whatsapp-quote.ts`, junto con las dependencias de la revisión aprobada. Confirmar el destino administrativo/montaje real y conservar el artefacto previo; no hay un comando administrativo verificado en este entorno y no se inventa uno.
4. Publicar el frontend de la misma revisión mediante el pipeline existente de Dokploy: cambia `WhatsAppConversationDialog.tsx` y su contrato `whatsappApi.ts`. Confirmar la rama/revisión seleccionada por el pipeline; no asumir que usa la rama de WhatsApp.
5. No se requieren migraciones ni nuevas variables/credenciales. Verificar presencia segura de las existentes y `WHATSAPP_LIVE_CATALOG_ENABLED=true` / moneda de tienda configurada, sin cambiarlas silenciosamente.
6. Comprobar salud HTTP 200, acceso sin sesión HTTP 401 y, con cuenta de prueba, audio sintético → OpenAI → DeepSeek → catálogo, error de cuota sin respuesta enviable, imagen DeepSeek y revisión manual en 320/390/1280. No enviar a clientes. Si falla, restaurar los artefactos previos coordinadamente y revisar qué comportamiento de audio se reintroduce.

## Comportamiento e historial anterior

Los párrafos siguientes registran etapas anteriores, incluyendo intentos inicialmente no publicados y publicaciones posteriores. No sustituyen la validación de esta entrega.

- El asistente valida la conversación, remitente, ventana de atención y consentimiento antes de procesar medios.
- Descarga únicamente el archivo indicado por el identificador de Meta. Solo HTTPS en dominios oficiales de Meta, sin redirecciones; imágenes limitadas a 5 MiB. La entrega actual vuelve a descargar audios bajo los límites descritos arriba.
- Audio en la base e639a4a: transcripción mediante gpt-4o-mini-transcribe. La entrega actual conserva esta etapa y agrega interpretación textual por DeepSeek.
- Imagen: selector DeepSeek deepseek-flash (predeterminado) / OpenAI gpt-4o-mini extrae observación y términos de búsqueda con JSON estructurado. Nunca decide precio, stock, compra ni cotización. Las imágenes ambiguas requieren aclaración.
- El texto interpretado pasa por el buscador del catálogo existente y por las lecturas actuales de Tiendanube. El operador ve la interpretación y la respuesta propuesta en celular y escritorio.
- Esta fase prepara respuestas a consultas de productos; no envía WhatsApp automáticamente ni altera los mensajes originales. Las transcripciones no se guardan como datos originales del cliente para emitir cotizaciones.
- Procesar una consulta repetidamente puede repetir la llamada al proveedor; no hay caché persistente de medios en esta fase.

Validación del 9 de octubre de 2026: 86 pruebas backend aprobadas, tipos y compilación correctos, navegador 320/390/1280 correcto. Las pruebas usan archivos y respuestas sintéticas, sin mensajes reales. La prueba real con una imagen pública del catálogo recibió HTTP 429, código credit_balance_exhausted, tipo insufficient_quota. No se publicó esta función en producción. Hace falta recargar la cuenta API existente y verificar imagen y audio con el proveedor real antes de publicar. No se cambiaron credenciales ni facturación.

Actualización: fotos priorizadas; DeepSeek devolvió HTTP 200 con interpretación JSON estructurada de una imagen pública real del catálogo. Se reutiliza exclusivamente la conexión verificada y cifrada existente. El selector de WhatsApp conserva la elección local, invalida propuestas anteriores al cambiar y nunca cambia silenciosamente de proveedor. OpenAI sigue condicionado al saldo API. Las fotos externas se utilizan como pistas para buscar alternativas en todo el catálogo, sin afirmar equivalencia exacta ni inventar precio o stock. Nuevos proveedores requieren adaptador, credencial segura y comprobación de visión antes de añadirlos al selector; no se aceptan destinos arbitrarios enviados por el navegador. En esa etapa histórica, la interpretación de audio quedaba para la siguiente fase.

Publicación comprobada: backend de fotos instalado con configuración existente intacta; crm-agent/health HTTP 200 y ruta protegida sin autenticación HTTP 401. Frontend release 123207d, Dokploy finalizado, HTML y bundle públicos HTTP 200 con selector. Se verificó celular 320/390 y escritorio 1280. La prueba real utilizó una foto pública del catálogo; falta la comprobación de extremo a extremo con una foto enviada por el cliente en WhatsApp. El HTML anterior puede estar en caché: recargar la página.

Corrección del 10 de octubre, release 3b31a3d: una referencia breve como «quiero esa» utiliza la imagen inmediatamente anterior, del mismo cliente y teléfono, validada por las reglas de WhatsApp. No salta mensajes intermedios ni reutiliza imágenes de otra conversación. La consulta visual omite marcas/colores/materiales que podrían no estar registrados en la ficha y conserva tipo/modelo/medidas; observación conserva la marca visible. La foto real del caso se interpretó como «bomba de condensado Mute Corner» y coincidió con la ficha «Bomba de condensado Mute coner», SKU «Mute corner 20L/H». Se verificaron 44 pruebas de flujo, compilación y navegador 320/390/1280; no se enviaron mensajes reales. Backend e interfaz publicados y salud HTTP 200. Sigue pendiente la validación del operador al pulsar Proponer respuesta sobre ese mensaje. HTML de rutas principales con Cache-Control no-cache, must-revalidate.

Solicitud posterior a la foto: «quiero que me cotices 5 de estas bombas» con datos completos. Se reconocen cotices/cotice/coticen/cotizas, referencia plural y cantidad del único modelo ofrecido; los datos personales después del RUT no se utilizan como filtros de producto. Se probó el backend corregido contra la conversación real y lecturas actuales de Tiendanube con un cliente HTTP limitado a GET/HEAD: formal_quote_ready, contexto completo y borrador de cinco Mute Corner a $63.784 IVA incluido cada una; neto $268.000, IVA $50.920, total $318.920. No hubo registros, folios consumidos ni envíos WhatsApp. 90 pruebas, compilación y navegador 320/390/1280 aprobados.

Contexto general de imágenes: se reemplazó el reconocimiento de frases fijas por interpretación de la imagen y los textos cronológicos de la consulta, anteriores y posteriores. Se analiza la imagen más reciente de la sesión actual del mismo cliente y teléfono, con los últimos 16 mensajes y sin enviar datos posteriores al RUT al proveedor. Saludos nuevos delimitan la sesión; bloqueos de atención, consentimiento y solicitud de persona siguen vigentes. Medidas alternativas se buscan por separado y las cantidades necesitan evidencia en mensajes del cliente. Para cotización se reutiliza el mismo flujo visual en preview/contexto/preparación y se preserva el proveedor elegido en celular y escritorio. Se ofrecen fichas/precios/stock/enlaces actuales o una aclaración concreta; no se inventan equivalencias exactas. Prueba real: foto de válvula más «necesito esa valvula se 5/8 y 1/2», con coincidencias SCV-11-5 ($21.455, 48 unidades) y SCV-11-2 ($15.200, 48 unidades). Lecturas con proveedor de visión autorizado, sin guardar cotizaciones ni enviar WhatsApp. 106 pruebas, tipos backend, compilación y navegador móvil/escritorio aprobados.
