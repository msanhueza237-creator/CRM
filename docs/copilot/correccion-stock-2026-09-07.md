# Copiloto: identificacion de productos y stock verificable

## Estado

Correccion publicada con autorizacion del usuario el 2026-09-07 (Chile), verificada contra fixtures, registros reales y consultas autenticadas al modelo en produccion. No requiere migracion SQL ni modifica datos de stock, Facto o contabilidad.

## Diagnostico

La busqueda anterior consultaba exclusivamente `inventory_snapshots` y exigia stock conocido incluso ante una pregunta general de existencias. Para RLD-382P, el resumen tenia `stock_known=false`, `available_units=0` y `source_product_id=450`, mientras que el producto Facto correcto es 262. Al excluirlo, el modelo interpretaba una lista vacia como falta de existencias.

En `product_details`, producto 262, el detalle de la bodega 1 registra `available_quantity=11.000000`. El campo agregado `inventories.total_available=0` difiere del detalle. La observacion de ese registro es del 2026-08-31, no una consulta en vivo. El catalogo Tiendanube permite resolver el enlace solicitado al SKU RLD-382P.

La verificacion anterior de rejilla documentada en `implementacion-lectura-2026-09-07.md` solo verificaba conservacion de filtros, no exactitud del inventario subyacente. Una respuesta vacia de aquella prueba no acredita agotamiento.

## Cambios

- Union por SKU exacto entre detalle Facto, resumen y catalogo; nunca por nombre aproximado para asignar cantidades.
- Detalle de bodegas como fuente de cantidad; suma decimal exacta de `available_quantity` sin restar nuevamente las reservas. Totales agregados discrepantes generan advertencia.
- Resumen con ID de otro producto descartado, incluidos sus precios, costos y demanda. SKU duplicado, ID inconsistente, bodegas repetidas o cantidades incompletas dejan stock desconocido.
- Cantidad explicita cero distinta de null. Sin detalle de bodegas solo se admite un resumen con stock conocido e identidad consistente; el stock web no se mezcla con el stock Facto.
- Nombres con acentos, plurales, distinto orden y errores menores; tolerancia de escritura solo para palabras descriptivas, nunca numeros de modelo. Coincidencias aproximadas requieren confirmar el modelo.
- URL del catalogo resuelta localmente, con normalizacion de www, barra final y parametros. No se navegan URLs suministradas por la IA ni se realizan solicitudes a destinos arbitrarios.
- `stock_filter=all` para preguntas generales de stock. El resultado distingue productos encontrados sin cantidad, excluidos por filtro y no encontrados.
- Fecha de observacion, fuente y detalle por bodega en cada resultado. No se sustituye la fecha del stock por la de un resumen mas reciente.
- Proteccion determinista de la respuesta cuando todas las consultas del turno son de productos y no hay cantidades verificadas. Una respuesta del modelo no puede convertir ese caso en stock cero.
- Para preguntas directas de stock con cantidades verificadas, respuesta construida desde las filas con fecha y fuente. Evita que el modelo presente observaciones historicas como existencias comprobadas en vivo o agrupe modelos distintos.
- Se conservan permisos, filtros financieros, auditoria, historial y lectura sin cambios de negocio.

## Verificacion

- `npm run test:copilot`: 38 pruebas correctas, incluidas 8 nuevas regresiones de inventario, busqueda, fuentes parciales, permisos y respuesta del modelo.
- `npx deno check supabase/functions/crm-copilot/index.ts`: correcto.
- `npm run build`: correcto; advertencia preexistente de bundles grandes.
- `npm run lint`: sin errores; 7 advertencias preexistentes ajenas a estos archivos.
- `node scripts/test-copilot-ui.mjs`: regresion de interfaz aprobada en 1440/1280/390/360 px con fixtures; historial, descarga y cancelacion conservados.
- Lectura SQL `BEGIN READ ONLY` sobre las fuentes reales, ejecutando localmente el registro corregido: nombre completo, SKU y enlace devuelven solo RLD-382P con 11 unidades. Consulta generica devuelve RLD-382P (11), UVD-3 (8) y MINIUV (10), cada uno con su propia fecha. No se guardaron copias de las fuentes ni se cambiaron registros.

## Publicacion

Respaldar la carpeta de la Edge Function antes de publicar. Actualizar juntos `product-resolution.ts`, `tool-registry.ts` y `orchestrator.ts` en el montaje existente de `crm-copilot`, y recargar el runtime de funciones. No ejecutar SQL ni scripts contables. El frontend actual entiende las columnas nuevas sin cambios.

Tras publicar, hacer consultas autenticadas reales por nombre generico, nombre exacto, SKU y URL; verificar resultado estructurado y texto final. Repetir un producto desconocido y uno con cantidad cero comprobada. Para rollback restaurar exclusivamente esos archivos desde el respaldo, sin eliminar conversaciones o auditoria.

Publicacion ejecutada: respaldo `/root/climactiva-backups/copilot-stock-20260908T004305Z/copilot-before.tar.gz`, verificado con lectura del tar. Tres archivos instalados y runtime recargado; hashes locales y remotos comparados. Consultas reales por nombre generico, URL y SKU devuelven RLD-382P con 11 unidades y fecha 2026-08-31. La consulta generica distingue los tres modelos. SKU inexistente informa falta de coincidencia, no stock cero. Las pruebas solo crean conversaciones etiquetadas y su auditoria habitual. No se ejecutaron migraciones contables pendientes.

## Limites

Esta correccion consulta las fuentes disponibles, no promete responder cualquier pregunta sin datos ni actualiza por si misma el sincronizador de Facto. Las observaciones antiguas deben comunicarse como tales. Persiste la necesidad de corregir el productor de los resumenes con IDs inconsistentes; el Copiloto ahora descarta esos datos en lugar de usarlos como hechos.
