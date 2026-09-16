# Copiloto empresarial: mapa del sistema

Inspeccion del 15 de septiembre de 2026. Proyecto existente, sin reemplazar CRM.

## Arquitectura verificada

- React 18 / Vite / TypeScript, React Router, lucide-react. `/copiloto` carga
  `CentralCopilotPage` de forma diferida; conserva el editor de borradores anterior.
- Supabase Auth valida JWT, perfil activo y rol en `crm-copilot/index.ts`.
  Roles: administrador, finanzas, vendedor, visualizador. Es una instalacion
  monocompania; no se afirma aislamiento multiempresa inexistente.
- `central.ts` administra sesiones, streaming NDJSON, mensajes, trazas y auditoria.
- `orchestrator.ts` ya utiliza Responses API y function calling de OpenAI.
- `tool-registry.ts` valida argumentos y permisos antes de consultar servicios.
- `sources.ts` integra PostgREST, RPC existentes y APIs internas. Las lecturas con
  service role requieren autorizacion previa del registro, nunca SQL del modelo.
- Postgres tiene 5 tablas de conversaciones/auditoria y confirmaciones existentes.
  RLS comprueba propietario/rol; administrador tiene lectura de auditoria.
- Nginx/Docker en Dokploy sirve el frontend. Edge Functions self-hosted en VPS.
  No se cambian DNS, banco, movimientos contables ni servicios de Facto.

## Modulos y fuentes

| Dominio | Fuente de verdad y servicio existente |
| --- | --- |
| Dashboard / Finanzas | accounting-center, accounting_source_documents, accounting_accounts, accounting_journal_entries/lines, accounting_dashboard_summary |
| Clientes | companies, contacts, interactions, tasks; ventas documentales enlazadas por RUT unico |
| Productos / precios | integration_records Facto product_details/inventory_snapshots; content_products Tiendanube; resolucion y valorizacion ya existentes |
| Cobranza | accounting_receivables/payables, saldos informados vs conciliados y calidad del ultimo respaldo |
| Comercio Exterior | import_shipments, foreign_trade_operation_lines/cost_lines/scenarios/documents, foreign_trade_operation_detail |
| Campanas | campaigns, campaign_recipients; registros Gmail/WhatsApp separados, sin enviar mensajes |
| Contenido | content_publications/channels/metrics/schedules; ultima medicion por publicacion |
| Prospeccion | prospecting_runs/campaigns, prospect_entities y evidencia activa; Google Places descubre y DeepSeek investiga |
| Agentes | business_agent_tasks; siete agentes existentes, module-reports y resultados historicos con fecha |
| Integraciones | integration_connections/sync_runs; secretos no incluidos en herramientas |

## Hallazgos

1. El modelo efectivo era OPENAI_TEXT_MODEL=gpt-4.1-mini. OPENAI_API_KEY existe
   solo en backend; acceso a gpt-5.6-sol verificado mediante API de modelos.
2. Informe transversal secuencial; varias lecturas amplias y resultados extensos
   al modelo. Cache existente solo por turno: no comparte datos entre usuarios.
3. Hay herramientas de productos/importaciones/contabilidad, pero faltan resumen
   financiero arbitrario por periodo, comparacion y ranking documental de clientes.
4. Fechas no incluyen ayer, ultimos 30 dias ni ano anterior. Calendario futuro
   necesita semana completa, distinta de semana transcurrida para ventas.
5. No existe contrato general de graficos ni adaptador de voz en el copiloto.
6. Historial persistente sin vencimiento explicito. No se borra historial existente
   sin autorizacion; nuevas sesiones deben tener vencimiento de contexto y politica
   de retencion documentada, con purga opcional separada de datos de negocio.
7. No se deben usar snapshots historicos como cifras actuales ni confundir
   facturacion, ingresos contabilizados, utilidad y dinero disponible.

## Implementacion

Se conserva la ruta y las herramientas existentes. Se agregan servicios de lectura
por periodo que reutilizan las politicas documentales/contables, configuracion
OpenAI central, telemetria sin secretos, contexto acotado y componentes tipados.
Las herramientas ofrecidas al modelo son solo READ; WRITE/ADMIN del negocio no
se ejecutan desde lenguaje natural. Su ejecucion futura exigira propuesta inmutable,
confirmacion del usuario, permisos frescos e idempotencia, usando copilot_confirmations.

Las pruebas de aceptacion usan datos reales de solo lectura, sin modificar clientes,
campanas, finanzas o integraciones. Preguntas/respuestas de prueba no deben cargarse
como actividad comercial. Las pruebas unitarias usan fixtures y mocks.

## Referencias oficiales consultadas

- https://developers.openai.com/api/docs/models/gpt-5.6-sol
- https://developers.openai.com/api/docs/guides/function-calling

## Implementation and operational configuration

- `config.ts` owns model, reasoning, source/turn deadlines, output budget and
  session length. Set `OPENAI_MODEL` on the edge runtime, never `VITE_OPENAI_*`.
  The legacy text/content integrations retain their own existing configuration.
- `business-analytics.ts` scopes document and ledger reads by entity and date,
  includes linked prior/later postings for deduplication, and uses the existing
  dashboard sales and cost-evidence policies. Unknown amounts are not zero.
- `get_sales_summary`, `compare_sales_periods`, `get_customer_sales`,
  `get_customer_profile`, and `get_loans` extend the existing registry. No SQL,
  arbitrary URL, accounting mutation or sending tool is exposed to the model.
- Financial summaries project current operational balances and verified bank
  balances. Old `*_confirmed` control totals and bank file paths/account numbers
  are not sent to the model as current balances.
- Structured `components` carry calculated KPI and line/bar series. Chart.js
  renders them with an accessible data table. No chart image generation.
- Model context gets bounded previews; original authorized results remain in
  UI/export. Tools run at concurrency 3 with request-local memoization only.
- Audit keeps the owner, question-message reference, role decision, tool names,
  safe arguments, result hashes, warnings and duration. Technical UI shows model,
  data/service accumulated times, total wall time and cache hits.
- `useCopilotVoice.ts` is a browser speech adapter. Dictation fills the same text
  composer; audio playback/stop uses that response. Microphone permission and
  speech support depend on the browser; no recordings are persisted by the CRM.
  The browser's speech provider may process audio. No second business engine.

## Session and retention design

- The model receives at most 12 recent messages by default; owner, active role
  and engine are checked again on every message/history/export request.
- New sessions expire for continuation after 30 days (configurable 1-90).
  History remains readable; expired sessions require a new conversation.
- Secrets are redacted before storing questions and answers, before model
  context, on tool results and on history/export responses. Provider responses
  use `store:false`.
- No existing history was deleted or retroactively purged: the user prohibited
  deleting information. Physical retention is separate from context expiry.
  Proposed policy for administrator approval: export/archive conversation text
  after 90 days, preserve only trace ID/owner/role/timestamps/tool names/hash
  for 365 days, then purge audit metadata. This is NOT an enabled purge job.
  Backup retention must follow the same policy when approved.

## Validation and known limits

See `enterprise-validation.md` for production read-only acceptance tests,
performance observations, UI checks and remaining data-quality limitations.

Voice and chart implementation references:
- https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API
- https://www.chartjs.org/docs/latest/getting-started/integration.html

Resultados de validacion y limitaciones se documentan al finalizar, no por anticipado.
