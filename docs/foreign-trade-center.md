# Centro de Comercio Exterior

## Arquitectura encontrada

- Frontend React + TypeScript + Vite, con rutas en `src/App.tsx` y navegación en `AppLayout`.
- Autenticación Supabase Auth y perfiles con roles `administrador`, `vendedor` y `visualizador`.
- Persistencia en Supabase Postgres con RLS. Los archivos privados utilizan Supabase Storage.
- Despliegue web como build estático servido por Nginx en Docker/Dokploy.
- Agent Hub existente con agentes `commercial` y `foreign_trade`, tareas, eventos, propuestas y borradores de compra.
- Entidades reutilizadas: `suppliers`, `supplier_products`, `import_shipments`, `shipment_milestones`, `business_settings` y `foreign_trade_actual_orders`.
- Catálogo maestro reutilizable en `content_products`, sincronizado desde Tiendanube.
- Datos de inventario, ventas y compras externas disponibles como snapshots de solo lectura en `integration_records`.

## Fase 1 implementada

La ruta privada `/comercio-exterior` está disponible únicamente para administradores. Incluye:

- resumen operativo con indicadores;
- registro inicial de simulaciones, cotizaciones, proformas, órdenes e importaciones;
- listado y filtros de operaciones;
- lectura de proveedores existentes;
- estados operativos y capacidades logísticas configurables;
- sección de parámetros de costos sin tasas legales codificadas en React;
- auditoría con valores anteriores y nuevos;
- diseño responsive coherente con el CRM.

La creación utiliza la función transaccional `create_foreign_trade_operation(jsonb)`. Cuando se informa un tipo de cambio, crea además un escenario base y congela ese valor.

## Fase 2 implementada

La migración incremental `supabase/foreign_trade_center_phase2.sql` convierte la base en una herramienta operativa sin adelantar todavía el motor financiero de la Fase 4:

- alta y edición de proveedores sobre la tabla existente `suppliers`;
- ficha privada de cada operación con resumen, productos y gastos;
- búsqueda limitada del catálogo oficial `content_products`;
- productos vinculados al catálogo o productos temporales en estudio;
- relación opcional y persistente entre SKU de proveedor y producto CRM;
- snapshot del producto al momento de incorporarlo a la operación;
- cantidades, costos de fábrica, embalaje, peso, CBM, origen y HS Code;
- gastos en moneda original, conversión operativa a CLP y método futuro de distribución;
- edición y eliminación auditada de líneas y gastos;
- identificación visual del origen `real`, `document`, `configured`, `estimated` o `simulated`;
- avisos explícitos cuando faltan costos, CBM, gastos o tipo de cambio.

Los totales de esta fase se muestran como **registrados**. No representan aún costo puesto en bodega, impuestos definitivos, margen ni rentabilidad certificada. No se modifica ningún precio comercial.

## Fase 3 implementada

La migración incremental `supabase/foreign_trade_center_phase3.sql` y la Edge Function
`foreign-trade-documents` agregan el flujo de documentos privados:

- carga de PDF, XLS y XLSX de hasta 25 MB al bucket privado existente;
- hash SHA-256 para identificar el original y ruta aislada por operación;
- descarga privada mediante URL firmada de corta duración;
- extracción estructurada de datos generales, productos, cantidades, precios, embalaje, peso, CBM, origen y HS Code;
- uso de archivos nativos en OpenAI Responses API desde backend, sin exponer `OPENAI_API_KEY`;
- verificación determinística de cantidad × precio y recálculo de CBM;
- estados `queued`, `extracting`, `review_required`, `confirmed` y `failed`;
- reintento seguro si la extracción falla;
- pantalla editable de revisión con confianza, advertencias, exclusión de filas y vínculo al catálogo;
- confirmación humana transaccional antes de modificar la operación;
- prevención de doble importación por documento y línea;
- conservación separada de `extraction_result` y `review_result`;
- auditoría resumida para evitar duplicar documentos completos dentro del log.

La IA nunca crea directamente productos ni cambia costos oficiales. La función de extracción solo
puede dejar el documento en `review_required`. El RPC `confirm_foreign_trade_document` materializa
los datos seleccionados después de una confirmación explícita de administración.

## Modelo privado

La migración `supabase/foreign_trade_center.sql` amplía las entidades existentes y agrega:

- `foreign_trade_role_permissions`
- `foreign_trade_agent_permissions`
- `foreign_trade_operation_statuses`
- `foreign_trade_container_types`
- `foreign_trade_operation_lines`
- `foreign_trade_scenarios`
- `foreign_trade_cost_lines`
- `foreign_trade_cost_parameters`
- `foreign_trade_documents`
- `foreign_trade_market_references`
- `foreign_trade_alerts`
- `foreign_trade_audit_log`

Los importes usan `numeric` con precisión explícita. Las líneas conservan snapshots históricos y distinguen datos `real`, `document`, `configured`, `estimated` y `simulated`.

## Separación de agentes

- `foreign_trade` recibe permisos de lectura, análisis, simulación y propuesta.
- `commercial` recibe esos mismos permisos con `allowed = false` de forma explícita.
- La función `foreign_trade_agent_has_permission()` solo puede ejecutarla `service_role` y será el contrato obligatorio para workers de la fase de integración del agente.
- Las tablas y documentos requieren permisos gerenciales mediante RLS.
- Las proyecciones de demanda, recomendaciones de reposición y alertas de inventario heredadas del Agent Hub también quedan bajo RLS gerencial.
- Las tareas, eventos, propuestas y configuraciones existentes relacionadas con comercio exterior dejan de ser legibles por usuarios no gerenciales.
- No se conectó el Agente Comercial a ninguna tabla nueva ni se le expusieron costos, márgenes o proformas.

Un proceso backend con `service_role` puede omitir RLS por diseño de Supabase. Por ello, en la fase del Agente de Comercio Exterior todo worker que construya contexto debe validar primero `foreign_trade_agent_has_permission()` y usar endpoints separados del agente comercial.

## Orden de instalación

Ejecutar en Supabase SQL Editor, después de las migraciones que ya están en producción:

1. `supabase/schema.sql`
2. `supabase/agent_hub.sql`
3. `supabase/content_center.sql`
4. `supabase/foreign_trade_actual_orders.sql`
5. `supabase/foreign_trade_center.sql`
6. `supabase/foreign_trade_center_phase2.sql`
7. `supabase/foreign_trade_center_phase3.sql`

Las tres migraciones del módulo son idempotentes y se pueden ejecutar nuevamente. La Fase 1 crea el bucket privado `foreign-trade-orders` y lo limita a PDF/XLS/XLSX de hasta 25 MB.

La carpeta `supabase/functions/foreign-trade-documents` debe quedar disponible dentro del volumen de
funciones del Supabase autohospedado y luego se debe redesplegar el servicio `functions`. Reutiliza:

- `OPENAI_API_KEY` obligatoria, ya utilizada por el copiloto;
- `OPENAI_TEXT_MODEL` como modelo por defecto;
- `OPENAI_REQUEST_TIMEOUT_MS` como timeout compartido;
- `CRM_APP_URL` para CORS.

Opcionalmente se pueden configurar `OPENAI_DOCUMENT_MODEL` y
`OPENAI_DOCUMENT_MAX_OUTPUT_TOKENS`. No se agregan secretos al frontend ni a las tablas.

## Verificación local

```bash
npm run test:foreign-trade
npm run test:content
npm run lint
npm run build
```

La prueba de comercio exterior instala las tres migraciones dos veces, valida el aislamiento del agente comercial, crea un proveedor y una operación con precisión decimal, vincula un producto del catálogo, calcula CBM determinístico, conserva el snapshot, registra un gasto y comprueba la ficha, los RPC y la auditoría. También simula una extracción con diferencias de total y CBM, confirma una revisión humana e impide confirmarla por segunda vez.

## Próximas fases

1. Fase 4: motor decimal de distribución, costo puesto en bodega, márgenes y comparación de escenarios.
2. Fase 5: alertas e historial ejecutivo.
3. Fase 6: API privada para el Agente de Comercio Exterior con validación de permisos y confirmación humana.
4. Fase 7: proyección de compras a partir de stock, ventas, tránsito y demanda existentes.

No se implementaron todavía cálculos legales, distribución de gastos, aprobación de compras ni cambios automáticos de precios. Las Fases 1, 2 y 3 dejan las fronteras y contratos preparados para incorporarlos sin rehacer el módulo.
