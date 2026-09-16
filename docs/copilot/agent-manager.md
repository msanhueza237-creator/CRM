# Gerente y especialistas: mapa e implementacion

## Auditoria previa

El CRM ya tiene siete identidades de agente, business_agent_tasks, module-reports.ts,
accounting-task-runner.ts, contratos de leases y propuestas con aprobacion. Los
informes programados del Gerente usan executive-daily.ts y executive_daily_noon.sql.
No se sustituyen ni se activan envios durante una conversacion.

Texto y voz ya entran por crm-copilot/central.ts. Live conserva WebRTC, sesiones,
interrupciones y voice-result. Responses, el registro de herramientas, permisos,
fuentes cacheadas por solicitud y las tablas copilot_* se reutilizan.

## Mapa de lectura

| Agente existente | Modulos / servicios | Fuentes | Permisos efectivos |
| --- | --- | --- | --- |
| executive | Gerente, Copiloto | Resultados de especialistas y evidencia del turno | Interseccion del perfil con herramientas disponibles |
| commercial | Empresas, ventas, prospeccion, precios | companies, integration_records Facto, prospecting_* y catalogo | customers/products; ventas solo sales autorizado |
| finance | Finanzas, contabilidad | accounting-center, accounting_* y documentos Facto sincronizados | finance |
| collections | Cobranza, cheques | accounting_receivables, accounting_checks, accounting-center | finance |
| marketing | Campanas, Centro de Contenido | campaigns, recipients, content_publications, schedules, metrics | campaigns/content + permisos de contenido |
| logistics | Inventario, productos | resolvedor de inventario Facto + content_products | products; costos solo finance |
| foreign_trade | Comercio Exterior | import_shipments, foreign_trade_operation_detail RPC, costos, lineas, escenarios | foreign_trade + permisos del modulo y del agente |

Los reportes antiguos son evidencia historica, no reemplazan las lecturas actuales.
La instalacion es monoempresa: entity() exige una unica entidad contable activa;
no se simula aislamiento multiempresa. No se modifica RLS ni se crean tablas.

## Diseno incremental

El Gerente dispone de herramientas de delegacion. Cada especialista es una
ejecucion del MISMO orquestador Responses, con una lista cerrada de herramientas
existentes y el mismo modelo configurado. No hay router de modelos ni herramientas
de escritura. El Gerente selecciona las areas y recibe analisis con evidencia;
consolida sin sumar snapshots ni monedas diferentes. Las consultas independientes
corren en paralelo con cache de fuentes por solicitud y plazos acotados.

Un fallo de especialista devuelve estado unavailable, preservando lecturas ya
obtenidas. La respuesta visual conserva tablas, graficos y exportaciones originales.
Contexto conversacional es compartido entre texto/voz; los resultados historicos
no autorizan cifras nuevas. Instrucciones en datos nunca sustituyen las del sistema.

La auditoria existente registra agente, herramientas, duracion, fuentes y uso.
Administracion consulta agregados acotados sin preguntas ni datos de clientes.
No se altera la retencion actual de sesiones (30 dias de contexto); la purga fisica
de historiales sigue requiriendo una politica de conservacion aprobada.

## Configuracion y reversibilidad

- OPENAI_REASONING_MODEL y OPENAI_API_KEY existentes, solo backend.
- COPILOT_AGENT_MANAGER_ENABLED=false restaura la ejecucion central anterior.
- COPILOT_MANAGER_TIMEOUT_MS: 150000 por defecto.
- COPILOT_SPECIALIST_TIMEOUT_MS: 75000 por defecto.
- Tarifas orientativas existentes OPENAI_INPUT_USD_PER_MILLION / OPENAI_OUTPUT_USD_PER_MILLION.

No hay migraciones de esquema, movimientos contables, envios ni cambios de cron.
Etapa 2: evaluar costo/calidad por agente con estas trazas antes de enrutar modelos.
