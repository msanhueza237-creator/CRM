# Inventario compartido con el Copiloto

El dashboard y la herramienta `get_inventory_valuation` usan el mismo calculo en
`supabase/functions/crm-copilot/inventory-valuation.ts`. La ruta autenticada
`GET /crm-copilot/inventory` consulta ese registro sin invocar IA ni escribir
datos contables. No necesita migraciones SQL.

## Fuentes y alcance

- Cantidad: detalle de bodegas Facto; resumen Facto o SKU exacto Tiendanube solo
  como respaldo cuando no hay cantidad verificable, segun `resolveProducts`.
- Costo: `product_details.cost.value`, con moneda de origen o confirmacion vigente
  por SKU, ID y valor en `copilot_cost_currency_confirmations`.
- Venta: `product_details.price.unit_net`, con lista y moneda identificadas.
  No se resta IVA nuevamente ni se suman varias listas.
- Totales de unidades disponibles y valorizacion sobre stock positivo de TODOS
  los SKU que cumplen los filtros, antes de la paginacion de 25 registros.
- Stock negativo, identidades ambiguas, costo cero o desconocido y precios sin
  moneda permanecen visibles como incidencias; nunca se valorizan como gratuitos.
- Monedas separadas. El costo sin moneda puede exponerse como referencia
  condicional en la moneda del precio; queda separado del costo confirmado.
  No cambia la moneda guardada ni se convierte usando un cambio supuesto.
- No se suman compras, importaciones, operaciones futuras ni saldos contables al
  stock. El panel es actual y no depende del periodo de ventas del dashboard.

## Permisos y filtros

Administrador y Finanzas pueden leer costos. Vendedor y Visualizador solo
reciben stock y venta por el Copiloto; no reciben campos, agregados ni filtros
de costos. El panel valorizado del dashboard se muestra solo a Finanzas/Admin.

Filtros: nombre/SKU, marca, lista, con stock, cero, desconocido, bajo umbral,
sin movimiento observado y costo por confirmar. Falta de historial no significa
falta de movimiento. Se conservan las fechas de cada fuente.

La respuesta incluye `totals`, `available_lists`, `available_brands`,
`source_dates`, filas paginadas, advertencias y enlace al filtro del dashboard.
Las exportaciones genericas del Copiloto conservan el resumen completo y aclaran
que la tabla corresponde a la pagina consultada.

## Verificacion y publicacion

- `node --experimental-transform-types --test scripts/test-inventory-valuation.mjs`
- `npm run test:copilot`
- `DASHBOARD_UI_URL=http://127.0.0.1:53702 node scripts/test-dashboard-ui.mjs`
- `npm run build`

Para produccion publicar frontend y la funcion `crm-copilot`, incluido el nuevo
modulo de valorizacion. Un despliegue solo frontend mostrara el inventario como
no disponible, sin recurrir a datos viejos ni inventar un total cero.
No incluir el trabajo pendiente de lectura del Libro Diario Facto ni migraciones
contables ajenas a este cambio.
