# DeepSeek API en Prospeccion

## Alcance

Un administrador activo puede guardar,
verificar, reemplazar y desconectar su clave desde **Prospeccion > DeepSeek API**.
Guardar la clave no inicia busquedas. Las nuevas ejecuciones de una campana con
`deepseek_enabled=true` usan V4 Flash con busqueda web nativa para descubrir hasta
30 sitios adicionales. El worker deduplica y enriquece los hallazgos nuevos desde
su sitio oficial. La asistencia no inventa empresas ni cambia contactos, territorios,
limites de resultados, reglas de admision o aprobacion.

La verificacion realiza solamente `GET https://api.deepseek.com/models`, con Bearer
token y redirecciones deshabilitadas. No envia datos de clientes ni consultas al modelo.
Contrato oficial: https://api-docs.deepseek.com/api/list-models/
La busqueda usa `POST https://api.deepseek.com/anthropic/v1/messages`, herramienta
`web_search_20250305`, pensamiento desactivado y `x-api-key` solo en el servidor.
Contrato oficial: https://api-docs.deepseek.com/guides/anthropic_api/
Solo los bloques `web_search_tool_result/web_search_result` aportan URLs.
Texto o listas generadas por el modelo no crean empresas. La busqueda es una
muestra complementaria, no un censo exhaustivo ni garantia de nuevos candidatos.

## Instalacion (requiere autorizar publicacion)

1. Respaldar y aplicar `supabase/prospecting_deepseek_settings.sql` en la base del CRM.
   Requiere `public.profiles` y los roles estandar de Supabase. Es idempotente;
   crea una tabla independiente y no modifica datos comerciales o contables.
2. Configurar `PROSPECTING_SECRET_ENCRYPTION_KEY` en el entorno privado del servidor
   de Edge Functions. Generar al menos 32 bytes aleatorios con un generador
   criptografico, codificados en base64. Nunca usar una variable `VITE_*`, la clave
   service-role ni una clave de DeepSeek como secreto maestro.
3. Mantener `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y `CRM_APP_URL` en el
   servidor. `CRM_APP_URL` debe ser el origen HTTPS del CRM; el valor predeterminado
   es `https://crm.latinchile.cl`. No se admite un origen arbitrario del navegador.
4. Desplegar la carpeta `supabase/functions/prospecting-integrations/` completa y
   el frontend. La funcion valida la sesion y el perfil activo en cada operacion.
5. Iniciar sesion como administrador, abrir la pestaña DeepSeek API e introducir
   la clave directamente en el campo privado. No compartirla por chat.

No hay credenciales reales incluidas. Las pruebas locales usan dobles de la API;
no acreditan por si solas una busqueda de produccion.

## Actualizacion para busqueda asistida

Requiere publicacion coordinada de SQL, `crm-agent`, `crm-copilot`,
`prospecting-integrations`, worker comercial y frontend; no basta la interfaz.

1. Respaldar funciones, definiciones y tablas `prospecting_campaigns`,
   `prospecting_runs`. Conservar el secreto maestro existente: NO regenerarlo.
2. Aplicar solamente `supabase/prospecting_deepseek_search.sql`, despues del
   esquema de Prospeccion y configuracion de credenciales. Agrega dos columnas,
   una tabla privada de reservas y funciones/trigger. No ejecutar SQL contable.
3. Publicar las tres carpetas de funciones completas, incluyendo el helper
   `crm-agent/prospecting-assistance.ts` y `crm-copilot/prospecting-report.ts`.
   El helper reutiliza `prospecting-integrations/deepseek.ts` del servidor.
4. Aplicar el overlay versionado `services/prospecting-worker-overlay/` al repo
   comercial, ejecutar sus pruebas y reconstruir/publicar el worker. No modificar
   su docker-compose ni secretos. El cliente declara `deepseek_web_v1`; un worker
   anterior no activa consumo ni recibe datos que no pueda procesar.
5. Publicar el frontend. Revisar `scope=search_assistance` en la API de estado.
6. Activar **DeepSeek Web** en una campana seleccionada y guardarla.
   Guardar no inicia una ejecucion. Las existentes conservan su snapshot.
7. Iniciar una ejecucion autorizada, revisar Operacion y confirmar consultas,
   sitios encontrados, tareas web y evidencia. `applied` con modo
   `web_discovery_v1` acredita la busqueda nativa, NO aprobacion de empresas.

La reserva admite una solicitud por ejecucion y 20 reservas por dia de Santiago,
con maximo 2500 tokens de salida y timeout de 45 segundos. La herramienta solicita
hasta tres consultas web; se registra el consumo real que informa el proveedor.
Las fallidas cuentan
para el limite conservador; no es un presupuesto monetario ni cambia los topes
de Google/Brave. Sin credito, modelo, clave valida o respuesta valida se usan los
terminos originales, indicando el motivo. Una solicitud interrumpida no se cobra
de nuevo automaticamente. El saldo de DeepSeek debe gestionarse en el proveedor.

El worker recibe una copia con `deepseek_discoveries`, asignada a una tarea web
existente. No se cambian terminos, IDs, comunas ni limites. Su fase compartida de
validacion web incorpora estos sitios aunque Brave no este disponible, registra
ese fallo por separado, deduplica contra Google y enriquece solo sitios nuevos.
No se crea evidencia Brave ficticia: nombre, contacto y domicilio proceden del
sitio oficial. Se intercalan ambas fuentes dentro del limite de la tarea.
`search_assistance` expone consultas, enlaces publicos, conteos y estado; las
reservas/tokens internos y la credencial permanecen privados. Sin direcciones y
contactos verificables los hallazgos no se importan. La aprobacion sigue manual.

El Copiloto consulta campañas, ejecuciones y evidencia activa por run mediante
`get_prospecting_report`. El enlace desde Operacion prepara una pregunta, sin
enviarla. No ejecuta campañas, no consulta credenciales y no consume DeepSeek.

Rollback: restaurar versiones previas de las funciones y frontend. Las columnas
aditivas pueden permanecer; no borrar snapshots, evidencia ni reservas. Para
desactivar nuevas asistencias basta desmarcar las campanas; los planes de runs
ya iniciados siguen siendo el respaldo de esas ejecuciones.

## Seguridad y operacion

- AES-256-GCM con nonce aleatorio y contexto autenticado. La tabla no concede
  acceso a `anon` ni `authenticated`; solo el backend usa service-role.
- La respuesta nunca contiene clave, fragmentos de clave ni ciphertext. No se
  guarda la clave en localStorage/sessionStorage ni en el workspace de prospeccion.
- Una clave nueva se verifica antes de reemplazar la guardada. La anterior se
  conserva si falla esa verificacion. Un fallo al verificar la clave existente
  registra estado de revision sin borrar la credencial.
- Desconectar elimina la clave del CRM, no la revoca en la cuenta de DeepSeek.
- No rotar el secreto maestro sin planificar el recifrado de las claves guardadas.
  Respaldarlo en el gestor de secretos junto con los respaldos cifrados; sin el
  mismo secreto las claves existentes no se pueden recuperar.
- Solo se envian terminos, territorios y tipos de empresa al modelo; no se envian cartera,
  facturas, clientes, RUT, telefonos ni claves del CRM en los mensajes.

## Pruebas

```sh
node --experimental-transform-types --test scripts/test-prospecting-integrations.mjs
node --experimental-transform-types --test scripts/test-prospecting-assistance.mjs
npm run test:prospecting
npm run test:copilot
npm run build
```

Interfaz aislada con Playwright, sin trafico externo ni credenciales reales:
`PROSPECTING_UI_URL=http://127.0.0.1:5190 node scripts/test-prospecting-integrations-ui.mjs`.
La prueba `node scripts/test-prospecting-assistance-ui.mjs` cubre filtros, guardado
de la asistencia, permisos, detalle de ejecucion, vista movil y enlace al Copiloto.

Revision de tipos: los helpers nuevos y `prospecting-integrations/index.ts` pasan
`deno check`. El chequeo global de `crm-agent/index.ts` y `crm-copilot/index.ts`
reporta 44 errores previos (tambien presentes en HEAD 2a43984), fuera de esta
integracion. No confundir ese chequeo global con la compilacion del frontend.
