# Copiloto: seleccion de modelo

## Arquitectura

El selector usa `GET crm-copilot/models`, autenticado con los permisos actuales.
El servidor intersecta los modelos habilitados con los modelos verificados de
`prospecting_ai_integrations`. Nunca devuelve ni envia al cliente su clave cifrada.
Solo al ejecutar un turno se abre la clave mediante el helper AES-GCM existente y
`PROSPECTING_SECRET_ENCRYPTION_KEY`. No se duplica la configuracion de credenciales.

DeepSeek usa su Responses API estateless. Reutiliza el mismo `runAgentManager`,
registro de herramientas, permisos, resultados visuales, historial y auditoria.
No permite URLs de proveedor ni claves enviadas por el usuario. No hay fallback
silencioso a OpenAI ante errores, saldo insuficiente o modelos retirados.

Texto y delegaciones de voz envian `modelChoice` al mismo endpoint de mensajes.
OpenAI sigue realizando el transporte de audio existente; el selector cambia el
razonamiento empresarial, no el modelo de voz. El selector se bloquea durante un
turno o sesion de voz. No hay nuevas herramientas de escritura.

## Opciones y persistencia

- DeepSeek V4 Pro y Flash: disponibles si figuran verificados en la conexion.
- OpenAI, modelo base configurado: conserva presupuesto y deshabilita escalamiento.
- OpenAI, politica automatica: conserva el router y restricciones Luna/Sol existentes.
- OpenAI, Sol (revision final): seleccion explicita de una revision con Sol despues
  de obtener la evidencia con el modelo base. Conserva el maximo de una llamada Sol
  por consulta y el presupuesto de USD 5. No ofrece esta opcion con Sol deshabilitado.

La preferencia para nuevas consultas se guarda por usuario/rol en el navegador.
La conversacion conserva el modelo elegido en su metadata al completar el turno;
abrir su historial recupera esa seleccion. Cada respuesta registra el proveedor,
modelo efectivo y opcion elegida. Cambiar modelo no borra la conversacion.

## Configuracion backend

- `COPILOT_DEFAULT_MODEL_CHOICE`: por ejemplo `deepseek:deepseek-v4-pro`,
  `deepseek:deepseek-flash`, `openai:default`, `openai:auto` o `openai:review`.
  Sin override, prefiere DeepSeek cuando existe la configuracion segura; instalaciones
  que no tienen DeepSeek conservan OpenAI. Un default explicito no disponible exige
  elegir otro, nunca cambia de proveedor a escondidas.
- `COPILOT_DEEPSEEK_MODELS`: lista permitida separada por comas. Un modelo futuro
  compatible con Responses se habilita aqui y verificando la conexion de la cuenta.
- `COPILOT_DEEPSEEK_RATES_JSON`: tarifas opcionales por modelo y millon de tokens,
  con claves `input` y `output`. No se usa una tarifa OpenAI para DeepSeek.
- `PROSPECTING_SECRET_ENCRYPTION_KEY`: reutilizada, no es una variable nueva.
- La voz y la politica de gasto OpenAI conservan sus variables actuales.

No se puede usar cualquier modelo de cualquier proveedor sin una integracion
compatible y sus credenciales. Agregar un proveedor nuevo requiere su adaptador
servidor y catalogo autorizado, no cambios en el Gerente ni en las herramientas CRM.

DeepSeek conserva `reasoning.effort=none` en todas las rondas del turno. Su llamada
inicial a herramientas es obligatoria y requiere ese modo. Cambiarlo a mitad del
bucle sin historial de razonamiento causa rechazos del proveedor. Los calculos
siguen realizados por las herramientas CRM, no por el modelo.

## Consumo y seguridad

Cada llamada DeepSeek registra inicio, resultado/error, agente, tokens, tiempo y
costo estimado en `copilot_audit_events`. No guarda clave, prompt, respuesta completa
ni razonamiento privado en esos eventos. Ante fallo de auditoria no inicia nuevas
llamadas. Consumo incierto se registra como desconocido, no como llamada gratuita.
Se mantienen limites de contexto, salida, tiempo y llamadas por solicitud.

El presupuesto diario de USD 5 existente es de OpenAI. No se consume ni se altera
con llamadas DeepSeek. El saldo y cobro DeepSeek pertenecen a su propia cuenta.
Sus estimaciones usan tarifas punta sin descuento de cache, no la factura final.
Las tarifas centrales por defecto se contrastaron el 26-09-2026 con la documentacion.

## Validacion y publicacion

`npm run test:copilot:models` verifica catalogo, seguridad, cifrado, tools, delegacion,
fallos, contexto y compatibilidad. `node scripts/typecheck-copilot.mjs` valida backend;
`npm run build` compila frontend. `scripts/test-copilot-ui.mjs` usa solo fixtures y
comprueba cambio de modelo, tablas, exportaciones y pantallas de 360 a 1440 px.

Sin migraciones ni modificaciones de contabilidad. Publicar frontend y `crm-copilot`
con sus dependencias, incluyendo el helper existente `prospecting-integrations/deepseek.ts`.
La rama de trabajo ya contenia cambios pendientes del router de costos: deben
revisarse sus dependencias al publicar, sin incluir otros cambios ajenos.

### Resultados del 26-09-2026

- 99 pruebas de backend, agentes, modelos, voz y control de gasto: correctas.
- Typecheck backend y compilacion frontend: correctos.
- Playwright con fixtures: cambio Pro/Flash/OpenAI sin borrar conversacion,
  selector visible a 360/390/1280/1440 px, historial y exportaciones correctos.
- Cuenta DeepSeek existente: Pro y Flash completaron ida/vuelta real de herramienta.
- Prueba aislada READ ONLY de inventario ST-1: Gerente y Logistica correctos con
  ambos modelos, misma herramienta `search_products`, 26 coincidencias registradas
  y cobertura completa. Sin escrituras empresariales. Tiempo acumulado del modelo:
  Flash 8,9 s; Pro 14,4 s (cuatro llamadas por consulta, no latencia garantizada).
- El runner aislado no transporta sesion de usuario. No permite validar rutas
  adicionales de Finanzas/Contenido que requieren esa sesion o RPC de permisos;
  esos controles no se omitieron. Validar la interfaz autenticada tras publicar.
- Audio fisico/microfono: no probado en esta tarea. Se probaron contratos y
  conservacion de la seleccion en las rutas de voz existentes.

### Paquete aislado de publicacion

Se excluyen Android, Realtime opt-in, lectores Facto, Contenido, extraccion documental
y SQL financiero pendiente. La voz web Live conserva su transporte existente.
El selector depende de `openai_cost_guard.sql`, migracion exclusivamente tecnica
de dos tablas y funciones privadas. En produccion falta esta dependencia: aplicar
solo con autorizacion, junto con DAILY_OPENAI_BUDGET_USD=5. La suspension inicial
por cuota se mantiene hasta que Administracion confirme haber resuelto el saldo.
DeepSeek usa la conexion cifrada existente y su auditoria, sin ese medidor OpenAI.

Validacion aislada: 146 pruebas sin llamadas a proveedores, TypeScript de
crm-copilot y build frontend correctos. Esto no confirma un despliegue.

Referencias oficiales:
- https://api-docs.deepseek.com/guides/responses_api/
- https://api-docs.deepseek.com/quick_start/pricing/
