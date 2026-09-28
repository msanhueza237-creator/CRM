# Gemini Live en el Copiloto

Gemini es un transporte de audio alternativo al OpenAI Live existente. Ambos usan
el mismo `useCopilotLive`, conversacion, endpoint `message`, Gerente, especialistas,
permisos, respuestas visuales y modelo de razonamiento seleccionado (incluido DeepSeek).
No habilita acciones de escritura ni sustituye agentes.

## Backend privado

- `GEMINI_API_KEY`: secreto exclusivo del contenedor Edge Functions.
- `GEMINI_LIVE_MODEL`: `gemini-3.8-live` por defecto; validado contra el catalogo de la cuenta.
- `GEMINI_LIVE_VOICE`: `Kore`.
- `GEMINI_LIVE_SESSION_SECONDS`: 900, limitado a 60-1800.
- `COPILOT_GEMINI_LIVE_ENABLED`: `true` por defecto.
- `COPILOT_DEFAULT_VOICE_PROVIDER`: `gemini`; si no esta configurado se ofrece OpenAI.
- `COPILOT_LIVE_ENABLED` sigue siendo el interruptor global de voz.

En Dokploy, guardar una variable no basta: `GEMINI_API_KEY: ${GEMINI_API_KEY}` debe
figurar en `environment` del servicio Edge Functions, y el contenedor debe recrearse
para recibirla. No reiniciar la base de datos ni imprimir el archivo de variables.
No usar prefijos `VITE_`, copiar claves al frontend o registrar URLs WebSocket con tokens.

## Flujo

1. `GET crm-copilot/voice-providers` devuelve disponibilidad, etiquetas y modelos, sin claves.
2. `POST voice-session` con `protocol: gemini` autentica al usuario, valida la conversacion,
   rol y modelo de razonamiento disponible; limita reconexiones y crea una auditoria.
3. El servidor solicita un token efimero de un uso a Google. El setup queda bloqueado
   en servidor: modelo, instrucciones, voz, VAD y unica herramienta `ask_manager`.
4. El navegador abre el WebSocket oficial restringido usando solo ese token temporal.
   AudioWorklet transmite PCM16; reproduce PCM24kHz. No usa grabaciones por archivos.
5. `ask_manager` se transforma en una delegacion UUID de la sesion; utiliza `message`
   y muestra los resultados habituales. `voice-result` recarga la respuesta persistida
   y autorizada; el cliente no puede suministrar un resultado empresarial al backend.
6. VAD interrumpe el audio y cancela consultas pendientes. Resultados tardios/cancelados
   no se envian al proveedor. Reconecta como maximo dos veces, con nuevo token e historial.
7. Finalizar, salir o perder conexion libera microfono/audio. No hay escucha fuera de sesion.

OpenAI conserva su WebRTC actual. Gemini utiliza WebSocket nativo y Web Audio; no
se presenta falsamente como WebRTC ni depende de ChatGPT abierto.

## Auditoria y limites

Se reutiliza `copilot_audit_events`: proveedor/modelo, sesion, usuario, duracion,
tiempo de conexion/delegacion/primer audio y tokens por modalidad cuando Google los envia.
La telemetria del cliente no es facturacion verificada. Gemini queda marcado con precio
desconocido (`estimatedUsd: null`), nunca como gratuito. La politica existente de gasto
del razonamiento no cambia; no es un limite global de facturacion de audio de Google.
No se almacena audio. El historial sigue la retencion existente del CRM.

El cierre corta la conexion del cliente y revoca el uso de herramientas del CRM. La
credencial de Google expira de forma acotada; el endpoint no afirma revocacion remota
inmediata ni confirmacion de que el usuario oyo el audio.

## Verificacion

`node --experimental-transform-types --test scripts/test-copilot-gemini.mjs scripts/test-copilot-live.mjs scripts/test-copilot-model-selection.mjs`

`node scripts/typecheck-copilot.mjs` y `npm run build`.

La prueba real del proveedor usa solo una consulta tecnica y resultado de prueba,
sin datos financieros ni cambios del CRM. Android, Bluetooth, ruido y latencia de
microfono necesitan verificacion en el dispositivo del usuario.

## Pantalla bloqueada y recuperacion web

Chrome puede suspender AudioContext, AudioWorklet o el microfono cuando la pagina
queda oculta o el telefono se bloquea. WebSocket conectado no demuestra captura
activa. La web no implementa deteccion local de "Oye Climactiva": una respuesta a
esa frase dentro de una sesion abierta es conversacion con el proveedor.

El transporte detecta suspension del contexto, mute del sistema y ausencia de
frames durante cuatro segundos (no confundir silencio con falta de frames).
Muestra "Audio suspendido", conserva el resultado escrito y descarta audio obsoleto.
Al volver a la pagina intenta recuperar el contexto; solo vuelve a "Escuchando"
cuando recibe frames. Si el navegador exige un gesto, ofrece "Reanudar audio".
Un worklet detenido solicita una unica reconexion dentro del limite existente,
sin repetir automaticamente la consulta al Gerente. Ocultar una pagina cuyo audio
sigue funcionando no cancela la conversacion. El mute voluntario no se considera fallo.

La auditoria acepta solo contadores numericos de captura, pausas, recuperaciones,
interrupciones de captura y cambios a segundo plano, sin audio ni transcripcion.
Las pruebas simulan estos eventos, no certifican pantalla bloqueada en Android.
`node scripts/test-copilot-audio-lifecycle-browser.mjs` verifica hook, panel y
transporte en Chromium con audio y backend de prueba, sin datos reales ni credenciales.
La conversacion sostenida con el telefono bloqueado requiere validar el cliente
Android nativo y su servicio de microfono; no se promete mediante un ajuste de Chrome.

Documentacion oficial: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
y https://ai.google.dev/api/live .
