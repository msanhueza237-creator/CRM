# Rentabilidad completa y escenarios anticipatorios

Implementación local autorizada por Marco, 1 de octubre de 2026. Proyecto existente `CRM climactiva`, rama `main`, base observada `eeebbcc`. Sin publicación ni operaciones financieras productivas. No se modificó la voz: Marco confirmó que funciona y retiró ese punto del alcance.

## Causa comprobada en código

El cálculo existente protegía correctamente el ranking de utilidad/margen ante costos o reversas pendientes, pero solo entregaba contadores y una muestra limitada de pendientes. Los documentos descartados por validación desaparecían del recorrido de resolución. La herramienta del copiloto marcaba cobertura completa sin reflejar exclusiones. No había motivos documentales ni acciones enlazadas suficientes para cerrar los casos.

Las cifras y nombres aportados en el chat no se consultaron ni verificaron en producción y no se incorporaron como datos o resultados fijos. Esta revisión no demuestra la causa concreta de cada uno de los 31 clientes mencionados; permite consultarla al ejecutar el flujo con los datos reales.

## Implementación

- `accounting-center/customer-profitability.ts`: mantiene los importes confirmados y el análisis parcial/provisional separados. Añade universo del filtro/período, clientes identificados, verificados, parciales/provisionales y sin calcular, cobertura documental global con denominador explícito y cohortes paginadas. Documentos de venta con importes no validables permanecen visibles sin afirmar cero como total. Guías y anulados quedan trazados como exclusiones justificadas y no crean costos pendientes artificiales.
- `profitability-issues.ts`: motivos por documento, folio, fecha, fuente, descripción de productos cuando está presente, factura relacionada de la nota y enlace al documento en Finanzas. No convierte descripciones en SKU ni precios/costos actuales en costo histórico. Identidades ausentes se mantienen separadas por documento; RUT duplicados entre fichas impiden certificar atribución.
- `readCustomerProfitability`: consulta las fichas por RUT y la fecha de último éxito del conector, bajo los permisos existentes; rechaza una ficha específica de identidad ambigua. No modifica datos. La frescura es del conector y no equivale a una nueva lectura de Facto. Más de 24 horas se presenta como advertencia, no como frecuencia garantizada.
- Dashboard: grupos Todos, Verificados, Parciales/provisionales, Sin calcular y Pendientes de resolución; paginación, documentos con motivos y enlaces a Finanzas/Empresas, fuentes y fecha. Reintento explícito ante fallo de lectura. El flujo reutiliza la revisión/importación de costo verificado y reversas existentes, con sus confirmaciones y permisos.
- Copiloto/Finanzas: misma herramienta `get_customer_profitability`, ampliada con `cohort` y `offset`, cobertura honesta, pendientes y acciones. El mejor verificado no se declara ganador de todo el universo. La respuesta canónica preserva importes y bases parciales. Ventas, utilidad, margen, recurrencia y cobranza se distinguen; no se usa volumen como utilidad o pago.

## Proyecciones: alcance implementado

`get_sales_projection` se integra en el registro y especialista financiero existentes, con sus permisos. Consulta documentos de ventas del mes actual hasta ayer, aplica las reglas documentales compartidas, deduplica por ID y descuenta NC una sola vez. No suma ventas contables y documentales.

Entrega escenarios conservador/base/optimista con ritmo restante de 75%/100%/125% del ritmo diario observado. Son supuestos de sensibilidad explícitos, no bandas estadísticas ni probabilidades. Muestra período, horizonte, fecha de fuente, método, límites, confianza y acción siguiente. Hoy se excluye por estar incompleto. No extrapola menos de tres días completos, ausencia de documentos, importes no validables, base neta no positiva o fuente antigua. Con fecha de fuente desconocida el escenario es condicional y de confianza muy baja. No modela estacionalidad ni días hábiles.

No se implementó un motor de proyección de margen, caja o quiebre de stock. El margen permanece sin estimar en esta herramienta. El copiloto recibió instrucciones para consultar las herramientas actuales de clientes, stock, ventas, importaciones y vencimientos cuando una pregunta las requiera, conservando permisos, correspondencia de SKU, fechas y límites. Esas recomendaciones no equivalen a nuevas capacidades predictivas verificadas ni a monitores automáticos.

## Qué se resuelve automáticamente y qué no

Se calculan y clasifican los datos que ya tienen evidencia contable vinculada. Al completarse legítimamente una evidencia en el módulo existente, la siguiente consulta elimina el pendiente y recalcula cobertura/ranking; no mantiene una segunda lista manual. Reutiliza costos contabilizados con contrapartida de inventario y reversas explícitas, cualquiera sea el importador de origen.

No rellena identidades, no reparte automáticamente costos de una importación entre ventas, no usa el catálogo actual como costo histórico, no inventa reversas ni crea asientos. No se encontró una base segura para inferir esas uniones por nombre o precio. Cada corrección real/ambigua sigue bajo revisión y permisos del usuario. El patrón reutilizable es un motivo estructurado con evidencia y acción dentro del módulo existente, no un CRM/agente nuevo.

## Validación del árbol final

- 162 pruebas aprobadas, sin fallos ni omisiones: rentabilidad, interfaz, completitud/proyecciones, agentes, fichas, notas/reversas, ventas, evidencia de costos y reportes multimódulo. Comando: `node --experimental-transform-types --test scripts/test-customer-profitability.mjs scripts/test-customer-profitability-ui.mjs scripts/test-profitability-completeness.mjs scripts/test-agent-manager.mjs scripts/test-company-insights.mjs scripts/test-credit-note-costs.mjs scripts/test-dashboard-sales.mjs scripts/test-facto-cost-evidence.mjs scripts/test-facto-cost-return.mjs scripts/test-business-module-reports.mjs scripts/test-business-module-ui.mjs`.
- Navegador aislado: `node --experimental-transform-types scripts/test-profitability-completeness-browser.mjs <salida>`. Componente, loader y cliente reales; API/autenticación sintéticas y toda red interceptada. Verificados grupos, página siguiente, enlaces de resolución, fuente antigua, reintento/recuperación, búsqueda sin resultados y 320/390/1280 px. Cero solicitudes de escritura y cero conexiones externas. Captura móvil inspeccionada.
- `tsc -b`, `npm run typecheck:copilot`, chequeo estricto del cálculo de rentabilidad y Vite build aprobados. Build sin cargar `.env.local`, con `envDir` externo vacío y salida en el espacio de trabajo. Conserva aviso previo por tamaño de bundles.
- Lint global: `node node_modules/eslint/bin/eslint.js src supabase services scripts --format json --output-file <salida>`: 14 errores y 14 advertencias heredados.
- Lint focalizado de los 16 archivos de código/pruebas afectados: 7 errores heredados, 0 advertencias. Comparación con las copias anteriores mediante ESLint API confirmó idénticos diagnósticos. Son 3 variables sin uso en accounting-center/index.ts, 1 en agent-manager.ts, 1 en orchestrator.ts y 2 en tool-registry.ts. Archivos nuevos sin errores. No se corrigió deuda ajena.
- Una ejecución restringida de las regresiones falló únicamente porque una prueba heredada escribe HTML sintético en `tmp/business-module-ui.html`. Se repitió con el acceso local autorizado y las 162 pruebas pasaron.

## Evidencia y límites pendientes

Espacio de trabajo: `C:/Users/msanh/Documents/Codex/2026-09-30/task/`.

- `completeness-backup/`: copias previas de archivos existentes.
- `completeness-tests-final.txt`: batería final.
- `completeness-browser-results/`: resultados y capturas sintéticas.
- `completeness-lint-global-final.json` y `completeness-lint-focused.json`: diagnósticos.
- `completeness-build-final/`: compilación final; asset principal `index-DHG35M7z.js`.

No se hicieron fetch, commits, push, despliegues, SQL productivo, sincronizaciones reales, llamadas a modelos facturables ni cambios de permisos. No se instaló software ni cambiaron dependencias. Se conservó el trabajo local anterior, incluida la voz.

No se verificó producción autenticada ni se resolvieron datos reales de clientes. El endpoint Edge y el frontend requieren una publicación separadamente autorizada para que Marco vea estos cambios en la web. Las pruebas del navegador usan API simulada; no certifican PostgREST/Edge desplegados ni respuestas de un modelo real. Los límites de tamaño del registro del copiloto se mantienen: si un detalle los supera, se pide acotar el período/cliente en vez de truncar y afirmar completitud.

## Extensión posterior de anticipación — 1 de octubre de 2026

La extensión autorizada agrega escenarios condicionales de stock/importaciones y señales comparables de compras de clientes. Reutiliza especialistas y permisos; no estima una fecha asegurada de quiebre ni declara clientes perdidos. Alcance, límites y 177 pruebas del árbol final en [operational-outlooks.md](operational-outlooks.md). Todo continúa local y sin publicar.
