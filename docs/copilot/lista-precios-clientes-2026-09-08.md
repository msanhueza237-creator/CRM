# Lista comercial de precios y stock

## Estado

Implementacion local verificada, pendiente de autorizacion de commit/despliegue. Sin migraciones ni escrituras de inventario, precios o contabilidad.

## Diagnostico

El stock ya utilizaba el resolvedor por SKU/catalogo/detalle Facto, pero `get_price_list` conservaba el buscador anterior. Ademas, una consulta corta como "manometro" podia consultar solo stock e interpretar precio desconocido del resumen como ausencia de precios. Las fuentes reales contienen precios netos para manometros y soportes de muro.

La captura muestra un fallo de transporte (`Failed to fetch`), no evidencia de producto inexistente. No se pudo atribuir ese corte a una causa unica a partir de los registros. Se mejora recuperacion y comunicacion sin afirmar que la red nunca volvera a fallar.

## Comportamiento

- Catalogo completo: `scope=catalog` ignora cualquier query anterior y entrega todos los SKU con stock verificado positivo, independientemente del limite de la tabla. Precios faltantes aparecen como `Por confirmar` en el Excel, no se inventan ni eliminan los productos. Consulta sugerida disponible en el Copiloto.

- `get_price_list` usa el resolvedor compartido, incluyendo nombres con plural/acentos, preposiciones, SKU y enlaces catalogados. Combina stock y precio por identidad, no por similitud de nombre.
- Precio neto de venta leido de `product_details.price.unit_net`. Sin calcular neto desde precio web, sin descuentos ni confundir costo con precio de venta.
- Monedas oficiales 5=USD, 38=EUR, 39=CLP, igual que el conector Facto existente. Admite `FACTO_CURRENCY_MAP_JSON`; IDs desconocidos no se suponen CLP.
- Varias listas Facto requieren seleccion. Precios repetidos/conflictivos no se eligen arbitrariamente.
- Respaldo comercial completo con productos de stock positivo, precio positivo, moneda, lista y fechas verificadas. Coincidencias aproximadas necesitan confirmacion por nombre/SKU y quedan fuera del envio automatico.
- El respaldo completo se guarda en la respuesta auditada, aunque la tabla este paginada. Al modelo se envia solo el conteo y pagina para evitar aumentar innecesariamente el contexto.
- Boton `Lista de precios (Excel)` revalida propietario y permisos mediante el endpoint de exportacion existente. Une las listas de productos consultadas, elimina duplicados identicos y bloquea versiones conflictivas del mismo SKU.
- Excel comercial independiente: SKU, Nombre, Precio neto y Stock registrado. Una hoja por moneda, filtro, cabecera fija, formato numerico, fechas de fuente y marca CLIMACTIVA. No exporta la conversacion, finanzas, costos ni datos privados de otros resultados del mismo mensaje.
- La IA conserva la intencion de consultar precios cuando el usuario indica un producto nuevo, sin reutilizar el nombre del producto anterior. Para precio habitual usa la lista de origen, no presume una tarifa de distribuidor.

## Conexion

- Heartbeat del stream cada 10 segundos para evitar silencios largos en proxies.
- El cliente termina al recibir `complete`, sin esperar un cierre posterior que pueda fallar.
- Error antes del envio: conserva el texto y retira el mensaje optimista no enviado.
- Corte despues de aceptar la consulta: puede recuperar una respuesta ya guardada usando `inReplyTo` y el historial autorizado. Nunca repite un POST automaticamente.
- Fallo actualizando la lista de conversaciones no se presenta como fallo de una respuesta ya guardada.

## Pruebas

- 42 pruebas de Copiloto aprobadas: precios y stock, cobertura completa de exportacion frente a pagina, listas ambiguas, datos faltantes, monedas, permisos y proyeccion al modelo.
- `deno check` correcto. Compilacion correcta. Lint sin errores y con siete advertencias preexistentes ajenas.
- Playwright: descarga comercial de mas filas que la pagina visible; cuatro columnas; numeros nativos; bloqueo de formulas; ausencia de informacion financiera de otra seccion; fallo de conexion antes del POST sin duplicacion; interfaces 1440/390/360 y regresiones existentes de historial/exportacion/cancelacion.
- Lectura real en transaccion SQL READ ONLY: manometros, 4 productos con precio/stock; soportes de muro, 7. Archivo generado mediante la descarga del frontend local, verificado con ExcelJS y renderizado sin alterar el libro con Artifact Tool. Datos observados entre 2026-08-31 y 2026-09-04, no stock en vivo.

## Publicacion

Actualizar juntos `product-prices.ts`, `tool-registry.ts`, `orchestrator.ts` y `central.ts` en la funcion `crm-copilot`, preservando el resto de archivos. Desplegar tambien el frontend compilado. Respaldar previamente los archivos de la funcion. No ejecutar SQL contable. Verificar consultas reales cortas, lista combinada y descarga desde una sesion autorizada tras publicar.
