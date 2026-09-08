# Agentes y reportes de productos

## Alcance

- Lectura del ultimo informe completado de los siete agentes mediante `get_agent_report`.
- Indice de secciones, detalle paginado, busqueda y enlace al panel original.
- No inicia agentes, aprueba propuestas ni modifica datos operacionales o contables.
- Mantiene el permiso `agents`, actualmente reservado al administrador. No amplia permisos indirectamente.
- Los resultados de agentes se identifican como historicos con fecha, periodo disponible y advertencias originales. La fecha de ejecucion no certifica actualidad de los datos.
- Los campos de credenciales y mensajes de campanas se excluyen. Los detalles anidados extensos se identifican como abreviados y conservan acceso al informe original.

## Ventas documentadas

`get_top_products` admite `group_by=product|month|year`, `identity_scope=catalog|all_lines` y `detail_level=summary|evidence`.

Para toda la gama: `query=null`, `result_scope=all_matches`. Para un producto o marca se conserva el filtro. El periodo se aplica antes de agrupar las lineas; no se agregan snapshots ni inventario a las ventas.

Las filas sin SKU confirmado se mantienen disponibles en `all_lines`, pero pueden contener servicios o fletes. El modo catalogo informa cuantos grupos requieren identificacion y nunca convierte ausencias en ventas cero verificadas. Las notas sin asignacion y netos no verificables mantienen el reporte provisional.

Los resumenes de ventas permiten hasta 900.000 caracteres para conservar el desglose mensual completo en tabla, auditoria y exportacion existente. El detalle documental conserva el limite de 180.000. Si se excede un limite se informa explicitamente; nunca se oculta un corte.

El modelo recibe una vista reducida de hasta diez lideres por periodo y moneda cuando hay mas de cien filas, marcada como vista parcial. La respuesta estructurada y la exportacion mantienen las filas completas; consultar un SKU recupera su detalle.

## Verificacion previa

- Pruebas unitarias del Copiloto y chequeo de tipos Deno.
- Lectura sin escrituras de los siete informes de produccion: 102 secciones verificadas (muestra de cinco filas por seccion).
- Lectura de documentos 2026: 159 documentos procesados, 219 productos identificados y 425 filas producto/mes. Estos conteos describen la fuente disponible, no certifican cobertura comercial completa.
- No requiere migraciones SQL ni alteracion de historicos.

## Compradores y facturas por producto

`get_product_sales_documents` reutiliza el mismo motor de ventas y permite consultar receptor, RUT, tipo DTE, folio, fecha, SKU y cantidad por linea. No depende del saldo de cobranza ni excluye documentos pagados. Conserva el periodo de la pregunta anterior; una cantidad como "esas 300 unidades" se contrasta con el total, sin filtrar artificialmente las facturas por cantidad exacta.

El documento y su detalle deben coincidir en identidad, direccion, folio y RUT cuando ambos informan esos campos. Los SKU exactos no incorporan otros modelos por semejanza de descripcion. Los netos no verificados permanecen nulos, sin impedir identificar al receptor y las cantidades documentadas.

Caso observado en el respaldo: agosto 2026, SKU FLARE 5/8, 300 unidades en folio 1553 del 27 de agosto. Existe otra venta de 300 en febrero; por eso una cantidad sola no identifica la factura.
