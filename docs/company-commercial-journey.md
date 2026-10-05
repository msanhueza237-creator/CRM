# Ficha comercial unificada

La ficha de empresa conserva rentabilidad y productos comprados, y agrega un historial por periodo de pedidos, documentos, referencias de cotizacion y actividad. No reemplaza el WhatsApp de Tiendanube ni emite documentos en Facto.

## Fuentes

- Pedidos: `integration_records`, proveedor `tiendanube`, recurso `orders`. RUT exacto y unico; solo sin RUT en el pedido puede usarse correo exacto y unico de la ficha. RUT contradictorio, correo compartido y nombres parecidos no se unen.
- Documentos: `accounting_source_documents`, entidad contable unica, fuente FACTO, facturas/notas de venta por RUT. Guias y compras excluidas. Notas y anulaciones conservan tipo y estado.
- Cotizaciones: interacciones CRM de tipo `cotizacion`, con folio en la descripcion y enlace opcional. Son referencias manuales, no una sincronizacion de cotizaciones de Facto ni confirmacion de conversion a factura.
- Actividad: interacciones por `company_id`. Tareas pendientes y proxima fecha de seguimiento se muestran independientemente del periodo historico.
- Utilidad y productos: se reutilizan las consultas existentes, sus permisos y sus advertencias de cobertura.

No se suman pedidos con facturas, no se infieren cobros, entregas de mensajes, consentimiento, relaciones entre documentos ni conversaciones historicas del WhatsApp de Tiendanube. Las lecturas son de la evidencia sincronizada en CRM, no de los proveedores en vivo. Una lista vacia no acredita ausencia de compras; errores y conflictos no se muestran como cero.

## Acceso y agentes

`GET crm-copilot/company-history` usa la autenticacion existente, acepta solo lectura y ejecuta `get_customer_journey`. La herramienta pertenece al agente Comercial y tambien puede consultarla el Copiloto. Solo administracion/finanzas consultan documentos e importes de venta segun los permisos existentes. Vendedor/visualizador conservan actividad CRM, sin consultas subyacentes de ventas.

La consulta no llama a modelos ni ejecuta sincronizaciones. Orden descendente por fecha, busqueda y paginacion de hasta 25 registros. La cobertura se refiere a registros almacenados; no certifica toda la historia del proveedor. Tareas: primeras 20 pendientes con cuenta completa, hasta el limite de seguridad. Los textos de origen son evidencia no confiable, nunca instrucciones.

Guardar una interaccion espera confirmacion persistida antes de actualizar la ficha. Abrir un borrador externo no se marca como mensaje enviado. No hay migraciones, cambios en Meta/Tiendanube, envios ni asientos contables.

## Verificacion

`node --experimental-transform-types --test scripts/test-company-journey.mjs scripts/test-company-insights.mjs`

`npm run typecheck:copilot` y `npm run build`.

Con Vite en puerto 5197: `node --experimental-transform-types scripts/test-company-journey-browser.mjs`. La prueba usa el componente real con un lector de datos ficticios; nunca contacta proveedores ni envia mensajes. Capturas en `tmp/company-journey-qa/` (no publicar). La vista de prueba local es `/scripts/fixtures/company-journey.html`.

Pendiente operativo: verificar la lectura real con el backend publicado y sesion autorizada. No presentar pruebas con fixtures como verificacion de datos de produccion. La sincronizacion automatica de cotizaciones y las relaciones cotizacion/pedido/factura no estan implementadas.
