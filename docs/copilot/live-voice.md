# Voz empresarial Live

Implementacion incremental sobre `crm-copilot`, 16 septiembre 2026.

## Arquitectura

Texto y voz usan `centralHandler`, `runOrchestrator`, `ToolRegistry` y las mismas
conversaciones, permisos por rol y fuentes de datos. La voz no implementa consultas
de negocio propias. El modelo principal usa Responses y razonamiento low, medium
o high segun la consulta. Una variable permite fijar el esfuerzo cuando sea necesario.

1. El navegador solicita microfono solo al activar Voz y crea un RTCPeerConnection.
2. Backend autenticado valida perfil y conversacion, negocia la oferta SDP mediante
   `POST /v1/live/sessions` y devuelve solamente respuesta SDP e identificadores.
3. Audio continuo por WebRTC; el canal `oai-events` recibe transcripciones y
   `session.delegation.created`. Los fragmentos no se usan como detector de turnos.
4. Una delegacion oficial envia la pregunta al mismo endpoint `message` de texto,
   con la conversacion compartida y clave idempotente derivada de sesion/delegacion.
5. Responses consulta las herramientas autorizadas. El frontend dibuja las mismas
   tablas, KPI y graficos con los resultados estructurados almacenados.
6. `voice-result` vuelve a leer la respuesta autorizada del servidor. Mediante una
   conexion sideband breve a `/v1/live/sessions/{id}/attach`, envia
   `session.commentary.append` y espera acuse. No confia en texto enviado por cliente.
7. Finalizar detiene inmediatamente las pistas de microfono, silencia la salida y
   cierra Live. El servidor tambien usa `/hangup` como cierre de respaldo.

Las conexiones sideband duran una operacion, no toda la llamada. Esto respeta el
limite de vida del worker Edge existente. Se usa `npm:ws@8.18.3` exclusivamente en
backend para autenticar el sideband. Su compatibilidad se comprobo en el runtime
Edge del VPS sin modificar la funcion publicada.

## Configuracion privada

```env
OPENAI_API_KEY=<secreto existente, solo backend>
OPENAI_REASONING_MODEL=gpt-5.6-sol
OPENAI_LIVE_MODEL=gpt-live-1
OPENAI_REASONING_EFFORT=auto
OPENAI_LIVE_VOICE=marin
COPILOT_LIVE_ENABLED=true
OPENAI_LIVE_USD_PER_MINUTE=0.05
OPENAI_INPUT_USD_PER_MILLION=4
OPENAI_OUTPUT_USD_PER_MILLION=20
```

`config.ts` centraliza los valores y conserva compatibilidad con `OPENAI_MODEL`
y `OPENAI_COPILOT_MODEL`. Las tarifas son estimaciones configurables, no cotizacion
ni factura. No hay recarga automatica ni nuevos limites de gasto artificiales.

Se verificaron el proyecto existente, su clave especifica del CRM, saldo, acceso a
ambos modelos y limites en la plataforma. No se crearon, revocaron ni revelaron claves.

## Seguridad y privacidad

- Cada operacion comprueba usuario, rol, propietario, conversacion activa y sesion.
- Un cambio de rol no permite continuar consultando una sesion del rol anterior.
- El canal del navegador solo admite cerrar y silenciar/activar audio; no puede
  modificar instrucciones, herramientas o resultados mediante eventos Live.
- Los resultados hablados se obtienen de mensajes almacenados por el backend,
  vinculados a la misma delegacion. No se envian resultados de otra conversacion.
- Una delegacion repetida no repite Responses. Un envio de resultado ambiguo no
  se reintenta automaticamente, para evitar hablar dos veces o datos obsoletos.
- El Copiloto central actual es de lectura. Voz no habilita nuevas escrituras:
  un "si, confirmo" no modifica contabilidad, precios ni envia comunicaciones.
- No se almacena audio. Live se crea con `store:false`; el CRM conserva las preguntas
  delegadas y respuestas bajo la politica de sesiones ya existente. Las transcripciones
  parciales viven solo en memoria del navegador, con limite de retencion local.
- Fuera de una sesion activa no se captura ni transmite microfono. No hay hotword
  permanente. Al salir de la pagina se liberan pistas, canal y conexion.

## Experiencia y observabilidad

Full duplex e interrupciones nativas de Live; boton de interrupcion con silencio
local inmediato. Mute deshabilita la pista local ademas de enviar el evento Live.
La reconexion intenta hasta dos nuevas conexiones, reutilizando la conversacion y
sin reenviar preguntas automaticamente. Texto sigue disponible si falla voz.

Se mantienen tiempos de modelo, herramientas, base de datos y respuesta total.
La voz agrega conexion WebRTC, primer audio observado desde la delegacion, RTT, jitter y
perdida de paquetes cuando el navegador los proporciona. RTT no se presenta como
latencia unidireccional. No se inventa una medicion de deteccion de voz del servidor.

Auditoria existente: `live_session_created`, `live_usage`, `live_result_delivery`
(pending), `live_result_acknowledged`, `live_error`, `live_session_ended`.
La duracion de Live es acumulativa: se toma el maximo por sesion, no la suma de
instantaneas. Diagnostico de administrador: usuario actual, ultimos 30 dias y hasta
1000 eventos; declara cobertura parcial, modelos no valorizados y fuente cliente.
Las tarifas no incluyen descuentos de cache ni fallos sin uso reportado.

## Pruebas realizadas

Pruebas reales en runtime aislado del VPS, API oficial y datos de produccion en
modo lectura. Un proxy restringido a loopback mantuvo autorizacion y secretos en
el servidor. El unico contenido de prueba persistido fue conversacion/auditoria
normal del Copiloto. No se modificaron documentos ni datos contables.

- Texto: ventas del mes, Responses con fuentes reales, KPI y grafico.
- Voz sintetica de prueba transmitida por WebRTC real: cobranza, doce meses de
  ventas, importacion proxima, informe ejecutivo y clientes inactivos.
- Sideband autenticado entrego respuestas habladas y obtuvo acuse del proveedor.
- Interrupcion durante respuesta: Live dejo de hablar, escucho la comparacion y
  conservo contexto de cobranza. Declaro falta de fotografia historica de agosto.
- Reconexion tras cerrar el transporte, mute/unmute y consulta posterior funcional.
- Microfono silenciado: audio de prueba no produjo transcripcion ni delegacion.
- Interfaz integrada revisada en escritorio y viewport 390x844, sin desbordamiento
  horizontal de pagina; controles de 48 px y resultados conservados al pasar a texto.
- Unidades: permisos, ownership, idempotencia, sesion invalida, secretos, advertencias,
  errores auditados, duracion acumulativa y configuracion del razonamiento.
- 109 pruebas correctas: 57 del Copiloto, 13 empresariales, 20 Live y 19 del
  dashboard financiero. Typecheck, ESLint de los archivos frontend afectados y
  build correctos. Se mantiene la advertencia previa de bundles grandes.

Tiempos observados de respuesta del cerebro: ventas 7,0 s; cobranza 10,2 s;
grafico 12,0 s; importacion 10,1 s; informe ejecutivo transversal 47,4 s.
Son muestras individuales, no un SLA ni una comparacion porcentual con la version
anterior. El informe largo queda cercano al timeout de 50 s del backend.

Pendiente: prueba fisica en Android, microfono real, Bluetooth y cambio real de red.
El viewport movil y el audio sintetico no sustituyen esas pruebas. Algunos datos
historicos/costos faltantes siguen declarandose como limitacion de la fuente.

## Referencias oficiales verificadas

- https://developers.openai.com/api/docs/models/gpt-5.6-sol
- https://developers.openai.com/api/docs/models/gpt-live-1
- https://developers.openai.com/api/docs/guides/live-delegation
- https://developers.openai.com/api/docs/guides/live-conversations
- https://developers.openai.com/api/docs/guides/voice-webrtc?api=live
- https://developers.openai.com/api/docs/guides/voice-server-controls?api=live

Esta validacion aislada no constituye por si sola publicacion en produccion.
