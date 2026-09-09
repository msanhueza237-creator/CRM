# Agentes y modulos: auditoria de fuentes

Revision de codigo: 9 de septiembre de 2026. Conexion de los siete agentes
implementada. No requiere migraciones SQL ni modificaciones contables.

## Autoridad

Los registros de los modulos son la fuente operacional del CRM. Facto y
Tiendanube siguen siendo evidencia externa identificable, no se descartan ni
se cambian sus fechas. Un informe de agente es una interpretacion con fecha,
no un reemplazo de los registros ni una prueba de actualidad.

No confundir saldo informado, saldo bancario conciliado, pago y asiento. Una
carga incompleta no transforma ausencias en cero. La fecha de consulta no
reemplaza la fecha de origen.

## Mapa de los siete agentes

| Agente | Fuente actual observada | Fuente operacional objetivo |
| --- | --- | --- |
| Comercial | commercial_snapshots, financial_snapshots, empresas CRM, inventory_snapshots | Empresas y actividad comercial; documentos y cobranza de Finanzas; catalogo compartido para productos |
| Marketing | Resumen comercial/financiero Facto, empresas, inventario | Campanas y Centro de Contenido; empresas autorizadas y catalogo; borradores y aprobaciones del modulo |
| Finanzas | Ultimo financial_snapshots de Facto | API de Finanzas: resumen, informes, periodos, cuentas y cobertura contable |
| Cobranza | collections dentro de financial_snapshots | Cartera operacional de Finanzas, incluida la importacion Excel; saldo informado separado de conciliacion bancaria |
| Logistica | inventory_snapshots de Facto | Catalogo/inventario sincronizado compartido mas embarques y recepciones de Comercio Exterior |
| Comercio exterior | Inventario, documentos de compras, referencias historicas de Gmail | Operaciones, proveedores, documentos, costos y conciliaciones del modulo Comercio Exterior; referencias externas solo como evidencia |
| Gerente | Documentos, snapshots, respuestas de campanas, propuestas e informes de agentes | Resumen transversal de los modulos, con enlaces al registro; informes de agentes claramente secundarios |

No se identifica un modulo independiente de inventario en las rutas revisadas.
No atribuir al panel del agente logistico autoridad de stock. Las sugerencias
de compra y simulaciones tampoco son recepciones de mercaderia.

## Hallazgos

- `src/modules/agents/AgentsPage.tsx`, `requestAgent`: construye payloads en el
  navegador. Finanzas y Cobranza leen snapshots en lugar de la API financiera.
  Marketing no carga las publicaciones/plantillas actuales del Centro de
  Contenido; Comercio Exterior no carga sus operaciones como base del analisis.
- `supabase/functions/crm-agent/index.ts`: tambien construye contextos para
  ejecuciones de servidor. Hay que actualizar ambas rutas, no solo el boton.
- `collectExecutiveSignals`: aplica limites de documentos/inventario y luego
  reduce resultados. Una muestra de alertas puede estar limitada; un total del
  negocio no puede calcularse desde esa muestra ni presentarse como exhaustivo.
- Los destinos de propuestas de compra y cobranza en `AgentsPage.tsx` todavia
  apuntan a paneles de agentes. Debe revisarse el registro destino del despacho
  antes de cambiar enlaces: un enlace nuevo no migra el registro creado.
- `supabase/functions/crm-copilot/tool-registry.ts` ya consulta informes y
  resumen de `accounting-center`, documentos consolidados, cheques, bancos,
  contenido e importaciones. Es una referencia existente para reutilizar
  fuentes y criterios, no para exponer todas sus herramientas a todo agente.

## Implementacion propuesta

1. Crear un constructor de contexto de servidor por agente, con lista explicita
   de modulos autorizados. Revalidar permisos del solicitante y entidad; una
   cuenta de servicio no debe ampliar permisos del usuario.
2. Leer los servicios/reglas de cada modulo, conservando moneda, periodo,
   fecha de origen, IDs/enlaces, cobertura, advertencias y version del contrato.
   Paginar con orden estable. Si la lectura no esta completa, bloquear los
   totales afectados o marcarlos como no disponibles.
3. Adaptar y probar los consumidores del worker antes de cambiar payloads.
   Inspeccionar su codigo desplegado: no se encuentra en `services/` de este
   repositorio, que actualmente contiene el conector Facto.
4. Hacer que las ejecuciones manuales y programadas usen el mismo constructor.
   Impedir que un payload antiguo o aportado por el navegador prevalezca sobre
   el contexto del modulo. Mantener evidencia del contexto usado en cada tarea.
5. Actualizar paneles y destinos de propuestas usando IDs reales de modulo.
   Mantener aprobacion humana para acciones externas o cambios contables.
6. Ajustar el Copiloto para distinguir hechos del modulo de recomendaciones del
   agente. Conservar los informes historicos sin reescribirlos como actuales.

## Primera etapa implementada

- `accounting-center/internal/agent-report` lee el mismo bootstrap/resumen del
  modulo, no un resumen del navegador. Requiere clave interna, tarea financiera
  existente, lease vigente y permisos financieros actuales del solicitante.
  Solo las tareas programadas sin solicitante usan la identidad interna.
  Si existe mas de una entidad activa se bloquea la lectura, no se elige una.
- `crm-agent/accounting-task-runner.ts` resuelve `finance/review_margin` y
  `collections/review_aging` al reclamar la tarea. Usa los RPC existentes de
  heartbeat, complete y fail, sin cambiar el worker Python externo. Se aplica
  igual a tareas manuales y programadas. Las sincronizaciones Facto y los otros
  cinco agentes conservan su ejecutor actual.
- El resultado incluye `accounting_module_report` con entidad, corte, consulta,
  base, advertencias, montos del modulo y detalle completo de cartera. Saldo
  informado y confirmacion bancaria son campos distintos. Acepta el Excel
  verificado que reconoce el modulo; no suma facturas para inventar deuda.
- Un fallo del modulo falla la tarea. No recurre a snapshots antiguos. No se
  generan propuestas, recordatorios, pagos ni asientos en esta primera etapa.
  La cobranza conserva su detalle para supervision y gestion desde Finanzas.
- El panel muestra primero el informe nuevo y enlaces al modulo. Los informes
  financieros del ejecutor anterior permanecen en una seccion historica.
- Los documentos fuente ahora se paginan con orden estable en el bootstrap;
  una lectura que llega al limite de seguridad falla explicitamente en lugar
  de publicar totales truncados.

### Verificacion y publicacion de las siete conexiones

Pruebas locales:
`node --experimental-strip-types --test scripts/test-agent-module-reports.mjs`,
`node --experimental-strip-types scripts/test-agent-module-ui.mjs`,
`node --experimental-strip-types scripts/test-agent-module-access.mjs`,
`npm run test:accounting`, `npm run build`.

La prueba de interfaz usa datos de prueba, no confirma cifras de produccion.
La pestaña local pudo leerse; la interaccion/screenshot posterior fallo por
desconexion del navegador. Falta comprobacion visual de escritorio y celular.

Antes de publicar: respaldar las funciones existentes. Desplegar el contrato
_shared/agent-module-contract.ts; accounting-center/index.ts y agent-report.ts;
crm-agent/index.ts, accounting-task-runner.ts, module-reports.ts y
module-pagination.ts; y crm-copilot/agent-reports.ts junto al frontend.
No se necesita migracion SQL. Verificar una tarea de los siete tipos y comparar su
corte y cifras contra Finanzas sin envios ni escrituras contables. No presentar
esa validacion como realizada hasta completar la comprobacion en produccion.
Rollback: restaurar conjuntamente las funciones y frontend de la version
anterior; conservar tareas e informes como evidencia, sin borrar historial.

## Conexion de los otros cinco agentes

`_shared/agent-module-contract.ts` declara las acciones que se resuelven con
fuentes de modulo. `crm-agent/module-reports.ts` aplica permisos, lee registros
completos y construye indicadores, recomendaciones de revision y enlaces.
Los roles se revalidan desde el solicitante almacenado; no desde el payload.
Solo un administrador puede solicitar los cinco informes transversales.
Se respetan ademas content.view, foreign_trade.view y la habilitacion de lectura
del agente de Comercio Exterior. No se modifican las tablas de permisos.

- Comercial: empresas, seguimiento, actividad, documentos y resumen financiero,
  mas catalogo sincronizado. No deduce deuda de ventas ni de informes anteriores.
- Marketing: empresas, catalogo, campanas, publicaciones y programaciones. Detecta
  aprobaciones y errores pendientes sin publicar ni crear campanas duplicadas.
- Logistica: el resolvedor compartido de SKU del Copiloto conserva identidad,
  stock desconocido y precedencia del detalle de bodegas. Importaciones y costos
  se presentan aparte; los escenarios no suman disponibilidad.
- Comercio Exterior: operaciones, proveedores, documentos, escenarios y costos
  con moneda y origen. No mezcla estimaciones, escenarios ni importes USD/CLP.
- Gerente: consolida los mismos bloques de modulo. Conserva el contrato
  executive_brief para los avisos configurados; una revision programada sin
  cambios no vuelve a notificar. Las pruebas/manuales usan auto_send=false.

Las tareas manuales ya no transportan snapshots desde el navegador. Comercial
y Gerente programados tambien encolan solo la intencion; consultan al ejecutar.
El punto comun de claim completa estos informes mediante los RPC existentes.
Las sincronizaciones y acciones especializadas ajenas al contrato mantienen
su ejecutor. Herramientas y reportes anteriores permanecen accesibles, separados
del informe operativo nuevo; sus cifras no alimentan este informe.

`module-pagination.ts` exige total verificable y avanza segun filas realmente
recibidas, incluso si el servidor limita las paginas. Un cambio de cantidad o
un error falla la tarea en vez de presentar un informe completo ficticio.
El panel pagina de 25 en 25 sin eliminar el detalle del resultado. Las tablas
anchas tienen desplazamiento interno para no romper el ancho del celular.
El Copiloto reconoce module_report/accounting_module_report y conserva la
distincion entre fecha de consulta y corte de origen.

Pruebas adicionales:
`node --experimental-transform-types --test scripts/test-business-module-reports.mjs`,
`node scripts/test-business-module-ui.mjs`, `npm run test:copilot`.

## Verificacion de aceptacion

- Una nueva importacion Excel modifica la cartera del modulo; una ejecucion
  posterior de Cobranza utiliza exactamente ese corte y saldo, sin generar pagos.
- Finanzas y Gerente coinciden con el informe del modulo para igual entidad,
  moneda, periodo y base contable; las cifras provisionales siguen siendolo.
- Un cambio de estado/costo de una importacion aparece en el siguiente analisis
  de Comercio Exterior y Logistica; los escenarios no aumentan stock disponible.
- Marketing reconoce borradores, publicaciones y aprobaciones existentes;
  analizar no envia ni publica contenido.
- Comercial respeta cambios de empresas y sus estados y no convierte facturas
  pagadas en deuda. Los productos con variantes mantienen su identidad.
- Pruebas de permisos, mas de una pagina, fuentes parciales, fuentes atrasadas,
  errores, monedas distintas y ejecuciones programadas/manuales equivalentes.
- Publicar despues de las pruebas locales y verificar un resultado real por
  agente en modo de solo lectura, sin envios, aprobaciones ni contabilizacion
  automatica. No dar por terminado el despliegue hasta comprobar esos resultados.
