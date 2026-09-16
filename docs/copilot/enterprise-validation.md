# Validacion del Copiloto empresarial

Fecha: 15-16 septiembre 2026 (America/Santiago).

## Alcance y entorno

- Proyecto existente, sin crear otro CRM ni sustituir su arquitectura.
- Backend probado en proceso aislado del VPS contra los servicios de produccion.
  El validador bloquea metodos de escritura, salvo Responses de OpenAI y RPC de
  lectura expresamente permitidas. No crea conversaciones de prueba en produccion.
- Modelo autorizado verificado: `gpt-5.6-sol`, Responses + function calling.
- Las credenciales se reciben solo por stdin privado en el servidor. No estan
  en argumentos, informes, frontend, repositorio ni archivos de resultados.
- Evidencia detallada privada en `tmp/enterprise-*-results.ndjson`; no se incluye
  en el commit. La matriz siguiente no publica nombres/contactos/cifras privadas.

## Aceptacion con fuentes reales

| Consulta | Herramientas contrastadas | Resultado |
| --- | --- | --- |
| Negocio este mes | sales_summary + financial_summary | Periodo y resultado coinciden con dashboard |
| Ventas mes pasado | sales_summary | Agosto completo, notas descontadas |
| Comparar meses | compare_sales_periods | Diferencias calculadas; mes parcial identificado |
| Deuda de clientes | accounts_receivable | Cartera completa, bases no sumadas |
| 10 mayores clientes | customer_sales | Ranking por neto documental/RUT y periodo |
| Clientes importantes inactivos | customer_sales | Umbral de 60 dias declarado; no certeza de abandono |
| Stock critico | search_products | Cantidades verificadas, desconocido distinto de cero |
| Productos mas vendidos | top_products | Unidades documentadas; notas sin asignar advertidas |
| Mejor margen por producto | product_profitability | Ranking paginado; moneda/costos condicionales visibles |
| Mercaderia en camino | imports + import_details | Estado real, lineas/unidades; no afirma embarque si esta en produccion |
| Proxima importacion | imports + import_details | ETA identificada como estimada |
| Informe financiero mensual | sales_summary, accounting_report, financial_summary | Periodo explicitado; utilidad distinta de caja |
| Informe ejecutivo | business_report + import_details | Fuentes de todos los dominios autorizados |
| Grafico ultimos 12 meses | sales_summary | 12 puntos estructurados, mes corriente parcial |
| Contenido programado | content scheduled/all | Incluye programacion futura, no solo hasta hoy |

Se compararon automaticamente todos los meses del ano actual con el dashboard
en ventas, costos, gastos, resultado, documentos pendientes, cobertura de costos
y regularizaciones de notas previas. Igualdad comprobada con tolerancia 0,01 CLP.

Seguimiento real probado: "Cuanto vendimos este mes?" -> "Y el mes pasado?" ->
"Comparalos.". Reutiliza contexto, pero consulta datos nuevamente en cada turno.

## Pruebas automatizadas y visuales

- 57 pruebas existentes del copiloto conservadas.
- 13 pruebas nuevas: configuracion, fechas, notas, deduplicacion, importes
  desconocidos, proyeccion de direccion, secretos, timeout, permisos, ranking y
  prestamos por entidad, errores de saldo/limite del proveedor y endpoint con
  auditoria/sesion en mocks.
- 19 regresiones del dashboard contable.
- Lecturas adicionales de ficha de cliente y prestamos contrastadas con sus
  servicios reales. Prestamos conserva el saldo por revisar ante reversas o
  importes desconocidos, sin modificar movimientos.
- `npm run typecheck:copilot` y `npm run build` correctos.
- Interfaz real renderizada en un transporte de prueba local con los resultados
  de lectura obtenidos del CRM. Escritorio y 390x844: grafico visible, KPI legibles,
  sin desbordamiento horizontal; datos del grafico accesibles como tabla.
- Dictado y reproduccion comparten la misma conversacion. No se grabo al usuario
  ni se probo fisicamente su microfono durante la validacion.

## Rendimiento observado

- Lecturas de ventas mensuales: aproximadamente 0,08 s.
- Comparacion de meses: aproximadamente 0,14 s.
- Ranking de clientes: aproximadamente 0,08 s.
- Serie de 12 meses: aproximadamente 0,46 s.
- Informe transversal (solo herramientas): aproximadamente 2,5-2,8 s.
- Respuestas completas con modelo en las primeras pruebas: 6-17 s para consultas
  puntuales; informes extensos hasta 51 s. Tras acotar la redaccion ejecutiva,
  la ultima prueba demoro 10,3 s para el resumen y 21,2 s para el informe completo.
  No se afirma una mejora porcentual frente a produccion sin benchmark comparable.
- Indices de fecha/entidad, identidad documental, integraciones y conversaciones
  ya existen en produccion. No se agregaron indices ni materialized views sin
  necesidad demostrada, ni se cambiaron esquemas contables.

## Limitaciones visibles y publicacion

- Hay costos/monedas pendientes y diferencias entre bases de cobranza. El copiloto
  las declara; esta tarea no las corrige mediante movimientos contables.
- Stock, importaciones y metricas son fuentes sincronizadas, no lectura en vivo
  de naviera/Facto/Meta. La fecha original queda visible.
- Voz depende del permiso y soporte del navegador; no es una certificacion de
  uso manos libres mientras se conduce.
- Contexto vence a los 30 dias; la retencion fisica del historial requiere aprobar
  la politica separada descrita en el mapa. No se borro historial existente.
- `npm audit` detecta 13 avisos del arbol existente (7 altos, 6 moderados), entre
  ellos xlsx y tooling Vite. Chart.js no figura entre los paquetes afectados.
  No se ejecuto `audit fix --force` ni una actualizacion mayor del CRM.
- Esta validacion no equivale a publicacion. Frontend y funcion `crm-copilot`
  deben publicarse conjuntamente tras autorizacion, con respaldo de la funcion
  anterior. No hay migracion de datos necesaria.
- Publicacion autorizada el 16 de septiembre de 2026. El plazo predeterminado
  del Copiloto se ajusta a 50 s porque el runtime existente limita cada worker
  a 60 s. No se modifica el runtime global; cualquier aumento por variable de
  entorno debe coordinarse con ese limite. El resultado del despliegue se
  verifica por separado, no se presupone en este documento.

## Comprobacion posterior a la publicacion

- Revision inicial `47805ce`: Dokploy termino correctamente; HTML, JS, CSS y
  bundle del Copiloto responden 200. Backend autenticado de conversaciones e
  inventario responde 200; acceso anonimo rechazado. Contabilidad sin cambios.
- La consulta real posterior devolvio 429 de OpenAI: `credit_balance_exhausted`
  / `insufficient_quota`. La cuenta API ya no tenia creditos, aunque el modelo
  seguia accesible. No se compro saldo ni se cambio de modelo para ocultarlo.
- Se agrego un mensaje explicito y prueba mock que distingue falta de saldo
  de limite temporal. Las pruebas previas con respuestas reales siguen siendo
  evidencia anterior, no una certificacion de disponibilidad sin saldo.
- Queda pendiente repetir la consulta completa en produccion cuando el titular
  recargue la cuenta API. No se deben compartir claves por chat para hacerlo.
