# Cotizaciones comerciales del CRM

El botón **Preparar cotización PDF** está en la conversación WhatsApp, en celular y escritorio. Extrae como borrador el RUT y los datos que siguen al RUT en el último mensaje; el vendedor debe revisarlos. Las cantidades de soportes de muro/techo se proponen al seleccionar un modelo, sin inferir códigos ambiguos.

El formulario recupera el historial del mismo cliente y número (hasta 500 mensajes recientes), interpreta selecciones numéricas sobre listas realmente enviadas y confirmaciones de producto/cantidad. Las cantidades explícitas de la solicitud de cotización prevalecen. No usa mensajes posteriores a esa solicitud ni ofertas fallidas; si falta un modelo inequívoco, lo señala. El mensaje de origen se fija al abrir el formulario para no sobrescribir ediciones mientras llegan respuestas nuevas.

1. Revisar emisor y cliente: nombre/razón social, RUT, dirección y comuna. Logo PNG/JPG opcional.
2. Buscar y seleccionar códigos únicos del catálogo Tiendanube; revisar cantidades.
3. Confirmar si los precios de tienda incluyen IVA o son netos, vigencia y condiciones de despacho/pago.
4. Consultar precios actuales y revisar total. No se crea ningún registro en este paso.
5. Confirmar y guardar la cotización en la ficha. El backend consulta nuevamente precios/stock y bloquea cambios hasta una nueva revisión.
6. Descargar el PDF o adjuntarlo a una respuesta vacía. Adjuntar no envía: **Enviar respuesta** sigue siendo una acción explícita.

La instantánea se guarda como interacción `cotizacion`, con UUID único, folio CRM, dueño autenticado y detalle JSON en `result`. Se puede regenerar el PDF desde el historial comercial de la ficha. Reintentos con el mismo UUID recuperan el registro y no crean duplicados. Los cambios posteriores preparan una nueva cotización.

No emite documentos tributarios, no se comunica con Facto, no reserva stock, no agrega productos al carrito ni confirma pago. No registra datos de prueba en producción. No requiere migraciones ni nuevas credenciales.

Precios CLP consultados en la variante actual de Tiendanube. Si son inclusivos, el neto es `round(total/1.19)` y el IVA es la diferencia; si son netos, el IVA es `round(neto*0.19)`. Redondeo por línea a pesos. El vendedor confirma explícitamente el modo en la revisión.

Preparación/registro requieren sesión de administrador o vendedor. Solo identificadores válidos y productos publicados con variante única, precio actual y stock suficiente. Los mensajes de origen deben pertenecer a la ficha. Logo local limitado a PNG/JPG de 180 KB; no se recuperan logos de URLs externas.

Pruebas: RUT/dígito verificador, IVA inclusivo/exclusivo, promoción actual, stock insuficiente, datos incompletos, doble registro, cambio de precio, PDF legible, revisión y adjunto manual con fixtures en 320/390/1280px. No envíos reales ni emisión automática.

Los precios de Tiendanube incluyen IVA 19%, confirmado por el negocio. La nueva
cotización mantiene ese precio final y muestra el neto unitario calculado como
precio / 1,19 (dos decimales), junto con Neto, IVA y Total del documento. El neto
del documento se redondea una sola vez a pesos; IVA = total publicado menos neto.
Este cálculo no se presenta como precio de Facto. Los registros de inventario de
Facto deben verificar moneda y correspondencia del producto antes de reemplazar
un precio de venta publicado; no se usan costos de compra para cotizar.

Se permite preparar y registrar una cotización comercial aunque falten datos del
emisor o cliente. El formulario y PDF enumeran campos pendientes y RUT por
verificar, sin inventar datos ni considerar válido un RUT incorrecto. Productos,
cantidades, precio actual, stock y confirmación manual siguen siendo necesarios.

El PDF usa encabezado del emisor y logo opcional, recuadro de RUT/folio, ficha del
cliente, tabla con cantidad, precio unitario neto, IVA y monto neto, observaciones
y totales. Conserva el folio único CRM existente (no asigna número de Facto).
La ficha del cliente conserva el snapshot y permite descargarlo posteriormente
con el mismo folio/precios; el PDF se genera con el diseño vigente. Documentos
largos repiten encabezado/tabla y muestran número de página y referencia.
Validación adicional: `node scripts/test-crm-quote-pdf.mjs` comprueba 20 productos,
varias páginas, folio, campos pendientes y totales sin solicitudes productivas.

Las nuevas cotizaciones guardadas reciben número correlativo desde 100, folio
CRM-100, CRM-101, etc. La vista previa no consume número. La función transaccional
register_numbered_crm_quote bloquea el contador, guarda número y snapshot juntos,
y devuelve el registro anterior si se reintenta el mismo UUID. Un fallo revierte
el contador. Solo service_role puede ejecutarla; las cotizaciones anteriores
conservan sus folios. El logo original sigue siendo el archivo opcional del emisor.

Emisor predeterminado: Importadora Latin Chile Limitada, RUT 77.724.382-9,
ENC LOS QUILLAYES LT 76 F, Curacaví (documento de referencia del negocio).
El logo original se incorporará cuando el negocio entregue el archivo.
El asistente propone respuestas cordiales para saludos, agradecimientos y
 despedidas. «Gracias por tu cotización» no inicia otra cotización; los mensajes
mixtos con solicitudes nuevas siguen sus rutas comerciales. Todo sigue siendo
una propuesta para revisión y envío manual dentro de la ventana de WhatsApp.

Observaciones se presenta vacío, sin condiciones automáticas ni textos técnicos.
Los datos pendientes siguen indicados en sus campos del emisor/cliente y en el
formulario. Al pie se muestra la transferencia para el emisor RUT 77.724.382-9:
Scotiabank, cuenta corriente 985659206, Importadora Latin Chile Limitada,
ventas@climactiva.cl. Datos transcritos de la imagen proporcionada por el negocio.
El backend fija estos datos y los guarda en el snapshot de nuevas cotizaciones;
no acepta cuentas bancarias suministradas por el cliente. Las cotizaciones antiguas
del mismo emisor pueden descargarse con el pie predeterminado del diseño actual.
