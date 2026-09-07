# Copiloto central: implementacion de lectura

## Estado

Implementacion local de las etapas de lectura y experiencia de conversacion de la propuesta. No se ha desplegado a produccion ni se han cambiado saldos, documentos, pagos, stock o datos de Facto durante esta implementacion.

La ruta existente `/copiloto` carga la nueva pantalla. El backend utiliza el modelo configurado en `OPENAI_COPILOT_MODEL`, o `OPENAI_TEXT_MODEL`, con `gpt-4.1-mini` como ultimo fallback. No se han cambiado credenciales ni contratado servicios nuevos.

## Entregado

- Registro de 20 herramientas de lectura, con contratos JSON cerrados, validacion en servidor y permisos por dominio antes de consultar.
- Function calling real con Responses API: hasta seis rondas, doce llamadas y tres lecturas simultaneas. Cache por turno, cancelacion y limite temporal de 150 segundos.
- Productos/stock, precios de origen, clientes, prospectos, demanda observada, importaciones y sus lineas/costos/ETA, documentos financieros, cartera, bancos/conciliacion, cheques, informes contables, campañas, publicaciones/metricas, agentes e integraciones.
- Informe ejecutivo que consulta las fuentes autorizadas de cada modulo y conserva las secciones parciales o fallidas.
- Fechas calendario America/Santiago; normalizacion de nombres/RUT/SKU; paginacion con conteo verificado; importes desconocidos distintos de cero; agregados monetarios de cuatro decimales sin suma binaria.
- Resumen financiero reutiliza `accounting-center/summary`, extraido del mismo flujo del dashboard. No usa el antiguo snapshot contable para responder sobre la posicion actual. La cartera informada por Facto no se suma a la conciliada.
- Metricas sociales usan la ultima medicion por publicacion. Una suma de alcance no se etiqueta como audiencia unica; metrica faltante sigue siendo null.
- Pantalla responsive, historial por usuario/rol, Markdown sin HTML ejecutable, tablas, KPI, evidencias, observaciones de calidad, estados NDJSON y cancelacion.
- Verificacion del contrato `/health` antes de consultar: una pantalla nueva no envia preguntas al motor anterior durante un despliegue incompleto. El servidor valida que exista la migracion antes de registrar un turno nuevo.
- Excel, PDF y CSV generados desde la respuesta respaldada. Antes de descargar se revalida propietario, rol y mensaje en el servidor. El respaldo reproducible es el contenido y resultado estructurado del mensaje, no una segunda copia del documento financiero original.
- Auditoria por llamada: identificador, herramienta/version, parametros depurados, estado, inicio, duracion y hash del resultado. No se guarda razonamiento interno ni credenciales.

## Limites deliberados

- Lectura de datos ya sincronizados en el CRM; no se afirma que cada pregunta consulte en vivo el ERP. Cada fuente conserva su fecha real. Los trabajos existentes siguen siendo responsables de sincronizar Facto.
- No se inventan tarifas de distribuidores/instaladores/consumidor. No se encontro un mapeo autorizado de esos segmentos a listas Facto. Se pueden consultar/exportar precios de origen conservando el ID de moneda cuando no hay codigo verificado.
- El ranking de productos utiliza el intervalo observado que entrega la integracion; no se transforma falsamente en un ranking mensual arbitrario. Para ventas por periodo se reutilizan informes contables.
- Un resultado financiero se presenta provisional. La herramienta no certifica cierres ni soluciona clasificaciones contables pendientes.
- Las exportaciones contienen las paginas consultadas y explicitan su cobertura; el boton de siguiente pagina conserva los filtros. No se anuncian como listados completos cuando hay filas restantes.
- La informacion de agentes es el resultado existente y fechado de sus tareas; no se lanza un segundo agente ni se elude el lease de Comercio Exterior.
- Gmail y WhatsApp se consultan a nivel de estado de integracion y campañas registradas. No se implementaron lectores libres de buzones ni envios.
- No se implementaron las nuevas acciones de escritura de la etapa posterior, aprobaciones genericas, tarifas nuevas, almacenamiento binario de artefactos o consultas historicas de cartera reconstruidas a una fecha de corte arbitraria.
- El flujo anterior de borradores permanece para administradores en `/copiloto?view=legacy`, con su endpoint separado `legacy-message` y la confirmacion existente. No forma parte del registro central de lectura.
- El endpoint de reportes anterior queda restringido a administrador/finanzas porque contiene agregados financieros. Vendedor/visualizador usan el nuevo Copiloto con proyecciones autorizadas.
- Conversaciones antiguas permanecen en la base. La nueva lista muestra conversaciones del motor central creadas con el rol actual; una baja de rol no expone respuestas financieras anteriores.

## Activacion coordinada

1. Respaldar las cinco tablas `copilot_*` existentes y los archivos actuales de ambas Edge Functions. No incluir los cambios contables ajenos a esta tarea.
2. Ejecutar `supabase/copilot_central.sql` sobre la base que ya tiene `openai_copilot.sql`. Es aditiva e idempotente; agrega metadata/indices y endurece SELECT del historial. No borra filas.
3. Publicar todos los archivos de `supabase/functions/crm-copilot/` y la version actualizada de `supabase/functions/accounting-center/index.ts`. En el VPS se utiliza el mecanismo existente de funciones montadas; no basta con desplegar solamente el frontend.
4. Conservar `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` y `OPENAI_API_KEY` solo en el servidor. `COPILOT_ENABLED=false` sigue desactivando el servicio completo.
5. Ejecutar `npm ci` y `npm run build`, y desplegar el frontend con el proceso existente de Dokploy. NDJSON necesita que el proxy no acumule respuestas; la funcion envia `X-Accel-Buffering: no` y `Cache-Control: no-cache, no-transform`.
6. Hacer una prueba autenticada real de stock conocido, cartera contra Finanzas, detalle de importacion, informe mixto e historial/descarga. Probar tambien un usuario sin permisos financieros. Las pruebas locales no sustituyen esta validacion operativa.

Rollback: volver a los archivos/build anteriores de Copiloto y accounting-center. Conservar metadata y mensajes nuevos; no ejecutar eliminaciones. Revisar las politicas del historial antes de restablecer accesos legacy amplios: la restriccion nueva corrige exposicion de datos financieros.

## Verificacion

- `npm run test:copilot`: pruebas de contratos, diez escenarios con proveedor IA controlado, aritmetica, permisos, calidad de fuentes, fechas, paginacion, cancelacion e historial. Incluye ejecucion idempotente de la migracion y RLS sobre PostgreSQL local con PGlite.
- `npm run test:accounting`: doble partida, inmutabilidad, reversas, balances y cierre existentes.
- `npx deno check supabase/functions/crm-copilot/index.ts supabase/functions/accounting-center/index.ts`.
- `npm run build` y `npm run lint`.
- Con Vite en `http://localhost:5179`, `node scripts/test-copilot-ui.mjs`: usa Chrome headless y fixtures de red, nunca modifica produccion. Verifica 1440/1280/390/360 px, Markdown seguro, historial, Excel autorizado y cancelacion. Evidencia local en `test-results/copilot/` (ignorada por git).

Pendiente antes de considerar la salida productiva validada: migracion/despliegue coordinado, pruebas con el modelo y las sesiones reales del entorno y comparacion de cifras contra los modulos al mismo corte.

Referencia de render seguro utilizada: [documentacion oficial de react-markdown](https://github.com/remarkjs/react-markdown).
