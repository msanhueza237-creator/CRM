# Cobertura de inventario y lista comercial

## Diagnostico 2026-09-09

- La lista de 52 filas no era un corte de paginacion. La mayoria de los registros
  `product_details` se habian reemplazado por fichas basicas sin inventario ni precio.
- El lector del hub devuelve la fila de listado cuando falla GET products/{id};
  la escritura anterior reemplazaba el detalle y actualizaba su fecha.
- Se verificaron respuestas HTTP 429. Las cantidades que faltaban en CRM si se
  obtenian consultando el detalle por API con espera y reintentos.
- El lector compartido tampoco consultaba stock/variantes de `content_products`.
- Los 252 SKU de la captura eran cantidades desconocidas, no stock positivo.

La auditoria de solo lectura termino con 314 detalles API leidos y sin solicitudes
fallidas tras reintentar una respuesta 429. El cruce encontro 333 SKU identificados:
204 positivos, 119 sin disponibilidad y 10 pendientes de cantidad/identidad.
La lista resultante contiene 204 filas, 11 con precio neto pendiente. Estos son
resultados de esa observacion, no constantes del sistema ni cantidades futuras.
No se modificaron registros productivos durante la auditoria.

## Regla compartida

1. Detalle de bodegas Facto por ID de producto y SKU consistente.
2. Resumen Facto con cantidad conocida y una identidad compatible.
3. Solo en ausencia de cantidad Facto, stock del SKU exacto de Tiendanube con
   fecha de sincronizacion. Las variantes se separan; no se usa el agregado del
   producto como cantidad de cada variante. Stock sin gestion o sin fecha queda
   desconocido. No se suman fuentes ni se reemplaza un cero Facto por Tiendanube.

El Copiloto y los agentes usan esa misma resolucion. Se informa por separado el
total de SKU positivos, no positivos y pendientes. `client_price_list.complete`
significa que el archivo contiene todas las filas seleccionadas, no que todos los
SKU tengan inventario verificado; `availability_complete` declara esa diferencia.
El Excel conserva SKU, nombre, precio neto y stock, con fuente y fechas en notas.
No exporta costos ni informacion financiera privada.

## Publicacion pendiente

Cambios del CRM: lector compartido, respuesta, informe de agentes, exportacion,
pruebas y `supabase/facto_preserve_product_details.sql`.

Cambios del lector en el proyecto existente
`C:/Users/msanh/Proyectos/agente inteligente comercial/clima-activa-agent`:
`app/hub/worker.py`, `app/integrations/facto.py`,
`tests/test_product_detail_retries.py`.
Limita a dos lecturas de producto en paralelo, reintenta fallas transitorias,
respeta Retry-After numerico y comparte la pausa cuando Facto responde 429.
Valida que el ID devuelto corresponda al solicitado.

Con autorizacion de publicacion:

1. Respaldar `integration_records` de inventario/productos y las funciones previas.
2. Aplicar solamente el SQL de preservacion de detalle de producto. Es un trigger
   atomico que conserva la fila anterior y sus fechas cuando llega una ficha
   basica del mismo producto. Un detalle nuevo con cero explicito si se acepta.
   No genera pagos, stock artificial ni asientos.
3. Publicar funciones CRM, frontend y los dos archivos del lector desde sus
   repositorios correspondientes. No incluir otros cambios locales pendientes.
4. Ejecutar la sincronizacion habitual de Facto y comparar por SKU, fuente y fecha.
   No cargar cifras de la auditoria como si fueran una lectura nueva.
5. Consultar una lista nueva y descargarla en escritorio/celular; los mensajes
   historicos mantienen sus resultados originales para auditoria.

## Verificacion

```powershell
npm run test:copilot
node --experimental-transform-types --test scripts/test-business-module-reports.mjs
node scripts/test-facto-product-retention.mjs
$env:COPILOT_UI_URL='http://127.0.0.1:5183'
node scripts/test-copilot-ui.mjs
npm run build
```

En el proyecto del lector:

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_product_detail_retries.py tests/test_inventory_snapshots.py tests/test_business_integrations.py -q
```

Auditoria opcional de solo lectura, usando la identidad SSH ya configurada sin
mostrar credenciales: `node --experimental-transform-types scripts/verify-price-catalog.mjs`.
Con `--retry` consulta solo los IDs fallidos del ultimo artefacto en `tmp/price-catalog`.
