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
