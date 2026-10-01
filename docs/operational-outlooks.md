# Extensión de anticipación: stock, importaciones y compras de clientes

1 de octubre de 2026. Implementación local en CRM climactiva, sin publicación ni datos productivos. Extiende la entrega de rentabilidad y proyección mensual de ventas; no crea otro módulo ni agente. Conserva voz y trabajo local.

## Viabilidad comprobada en código

Las herramientas existentes exponen stock observado por SKU y fuente/fecha (`search_products`), cantidades facturadas por SKU/período con cobertura documental (`get_top_products`), operaciones y ETA estimadas (`get_imports`) y cantidades por línea de operación (`get_import_details`). Los documentos de ventas y fichas por RUT permiten comparar actividad de clientes. Esto acredita el contrato del código, no que hoy todos esos datos estén completos en producción.

No se encontró cobertura suficiente de reservas, pedidos comprometidos, mermas, conversiones de unidad/embalaje, demanda futura o disponibilidad efectiva después de aduana. Por eso se mantienen desconocidos; no se inventan ni se deducen del stock o de la ETA.

## Stock/importaciones

Nueva herramienta de lectura `get_stock_outlook`, dentro del registro y especialista Logística existentes. Dominio `sales`: vendedores y visualizadores no reciben ventas ni análisis derivado sin permiso.

- Requiere un SKU exacto único. Reutiliza las búsquedas y reglas de stock/documentos existentes; no une por nombres parecidos ni por SKU de proveedor.
- Ventana predeterminada: 30 días completos hasta ayer, configurable entre 7 y 90. Ritmo = unidades facturadas/documentadas ÷ días; cobertura condicional = cantidad observada ÷ ritmo. No es consumo físico ni fecha de quiebre.
- Exige stock conocido, no negativo, con fuente/fecha reciente, sin advertencias, y serie única del SKU con cobertura completa, unidades positivas y al menos tres documentos. Stock y evidencia de ventas de más de 24 horas o sin fecha impiden el escenario. No transforma fallos de lectura en cero o SKU inexistente.
- Reservas y fecha de agotamiento físico permanecen `null`. Explica supuestos de ritmo constante y equivalencia de unidades. Confianza baja; propone verificar físico, reservas, unidades y reposición.
- Con permiso de Comercio Exterior consulta hasta cinco próximas operaciones, o una operación seleccionada mediante `operation_id`. Mantiene las comprobaciones de permiso del módulo de las herramientas originales. Sin permiso no consulta importaciones.
- Cruza líneas con SKU exacto, verifica IDs/duplicados, cantidades y cobertura de página. No acredita una cantidad completa si el detalle supera las 100 líneas consultadas. Informa explícitamente alcance de operaciones y páginas; no deduce ausencia global desde una muestra.
- Conserva ETA como estimada. Fecha ausente, vencida, inválida o datos de importación antiguos requieren confirmación. Compara días hasta ETA con cobertura solo como escenario condicionado. La mercancía planificada no se suma al stock disponible ni acredita fecha de venta.

## Caída de compra

Nueva herramienta de lectura `get_customer_purchase_signals`, incorporada al especialista Comercial existente y protegida por el dominio `sales`.

- Compara dos ventanas consecutivas de igual duración, por defecto 30 días cada una, hasta ayer. No compara un mes parcial con uno completo.
- Usa documentos únicos, RUT normalizado y fichas no ambiguas. Duplicados de lectura no aumentan actividad. Identidad ausente/duplicada e importes no verificables impiden afirmar una variación.
- Separa compras emitidas antes de NC, ventas netas y número de NC. Una nota o regularización no cuenta como nueva visita/compra. No atribuye una caída de neto causada por NC a abandono.
- Señal orientativa: caída de al menos 30% en compras, con al menos tres días distintos de compra en la ventana previa. Es una regla de revisión, no una prueba estadística. Muestras pequeñas, falta de base previa y fuente antigua/desconocida tienen avisos propios.
- Última compra y días transcurridos se limitan a las ventanas leídas. No afirma pérdida del cliente, ni interpreta falta total de documentos como cero ventas garantizado. No ajusta estacionalidad.
- Entrega clientes paginados, fuente/fecha, método, documentos de evidencia, motivos y enlace a la ficha o revisión de Empresas. Recomienda revisar historial y, solo con autorización posterior, un contacto comercial. No envía mensajes.

Las respuestas canónicas de una sola herramienta preservan supuestos, faltantes y errores; no se sustituyen por una afirmación más concluyente del modelo. Con varias fuentes se conserva la consolidación existente, con instrucciones explícitas de incertidumbre y permisos.

## Verificación del árbol final

- 177 pruebas aprobadas: las 162 de rentabilidad, agentes, fichas, reportes, ventas, costos/reversas más 15 casos nuevos de ventanas comparables, bisiesto, duplicados, NC, identidades, frescura, falta de datos, stock negativo, SKU ambiguo, cobertura parcial, ETA incierta/vencida, permiso denegado antes de leer, recuperación y resúmenes canónicos.
- `tsc -b` y `npm run typecheck:copilot` aprobados.
- Vite build aprobado con directorio de entorno externo vacío: no se cargó `.env.local`. Mantiene advertencia de bundles grandes. El frontend no cambió en esta extensión; su asset principal sigue `index-DHG35M7z.js`.
- Lint global `eslint src supabase services scripts`: 14 errores y 14 advertencias heredados. Alcance focal de esta extensión (seis archivos): cuatro errores heredados, sin advertencias; nuevos módulos/pruebas sin errores. Los cuatro pertenecen a variables sin uso ya existentes en `agent-manager.ts`, `orchestrator.ts` y `tool-registry.ts`.

Comando final de pruebas:

```powershell
node --experimental-transform-types --test scripts/test-operational-outlooks.mjs scripts/test-customer-profitability.mjs scripts/test-customer-profitability-ui.mjs scripts/test-profitability-completeness.mjs scripts/test-agent-manager.mjs scripts/test-company-insights.mjs scripts/test-credit-note-costs.mjs scripts/test-dashboard-sales.mjs scripts/test-facto-cost-evidence.mjs scripts/test-facto-cost-return.mjs scripts/test-business-module-reports.mjs scripts/test-business-module-ui.mjs
```

Evidencia en `C:/Users/msanh/Documents/Codex/2026-09-30/task/`: `outlooks-backup/`, `outlooks-tests-final.txt`, `outlooks-lint-global-final.json` y `outlooks-build-final/`.

## Límites y pendientes

No se consultaron saldos, stock, clientes ni importaciones productivas durante esta tarea. Las herramientas consultarán las fuentes autorizadas al ejecutarse después de una publicación aprobada. Las pruebas usan fuentes/modelos sintéticos y no verifican respuestas reales del modelo ni el estado de servicios desplegados.

No se implementaron predicciones estadísticas calibradas, confirmación de reservas, recepción automática, alertas programadas, monitores externos, mensajes o campañas. No hicieron falta nuevas integraciones ni refactor amplio. No hubo instalación, cambio de permisos, SQL productivo, sincronización real, commit, push o despliegue.
