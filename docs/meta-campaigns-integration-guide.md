# Guia de integracion: WhatsApp Meta Cloud API

Esta integracion debe operar siempre con una separacion clara:

CRM LatinChile -> Backend seguro -> Meta WhatsApp Cloud API -> Webhook -> Historial CRM.

El frontend nunca debe enviar mensajes directamente a Meta ni manejar tokens permanentes.

## Requisitos Meta

1. Crear una app de negocio en Meta for Developers.
2. Agregar el producto WhatsApp.
3. Obtener:
   - Phone Number ID.
   - WhatsApp Business Account ID.
   - System User Access Token permanente.
   - App Secret para validar webhooks.
4. Crear plantillas aprobadas por Meta para campanas comerciales.

## Secretos de backend

Configura estos valores solo como variables de entorno o secretos del backend/Edge Function:

```bash
META_WHATSAPP_ACCESS_TOKEN=...
META_WHATSAPP_PHONE_NUMBER_ID=...
META_WHATSAPP_BUSINESS_ACCOUNT_ID=...
META_WHATSAPP_WEBHOOK_VERIFY_TOKEN=...
META_WHATSAPP_APP_SECRET=...
META_GRAPH_API_VERSION=v26.0
META_WHATSAPP_PRODUCTION_APPROVED=false
```

No guardes estos valores en `localStorage`, en el frontend, ni en archivos versionados.

`META_WHATSAPP_PRODUCTION_APPROVED` debe permanecer en `false` durante la demo interna. Cambialo a `true` solo despues de verificar cuenta, numero, permisos y plantillas, con autorizacion del administrador. Este indicador interno no acredita App Review ni publica la app de Meta.

En Dokploy no basta con guardar una variable: debe mapearse tambien en `services.functions.environment` del Compose al contenedor Edge Functions. Verificar presencia, nunca imprimir el valor. No reiniciar el resto de Supabase para actualizar solo esta funcion.

## Comprobacion desde el CRM

En `Administracion > WhatsApp Meta` usa **Probar conexion real**. La comprobacion es de solo lectura y no envia mensajes. El CRM informa por separado:

- si el webhook ya recibio eventos;
- si el token, Phone Number ID y WhatsApp Business Account ID responden correctamente en Meta Cloud API;
- si la autorizacion de produccion fue confirmada expresamente.

La respuesta nunca incluye el access token ni el App Secret.

## Uso desde campañas

El administrador abre **Enviar via Meta API**. El CRM consulta las plantillas de la cuenta, muestra las aprobadas con su idioma exacto y una vista previa. Las variables se solicitan solamente cuando la plantilla las necesita. Se admiten texto y botones de catalogo, URL estatica o telefono; otros componentes quedan bloqueados hasta implementar su soporte.

- `GET /meta-whatsapp-templates`: lectura con sesion de administrador activo.
- `POST /meta-whatsapp-send`: requiere la misma sesion, campana guardada, `templateId`, `language`, destinatarios y `confirmSend: true`.
- La ruta antigua `/send-campaign` exige ahora tambien sesion administrativa y el contrato nuevo; una API key de agente por si sola no permite enviar.
- Token Meta solamente en backend. No se solicita una clave al usuario en el formulario.
- Plantilla aprobada verificada nuevamente en Meta antes de cada lote de hasta 10.
- Consentimiento vigente y telefono coincidente con la empresa, sin excepciones administrativas.
- Confirmacion explicita de destinatarios y posible costo. Consultar plantillas o cerrar el modal nunca envia mensajes.
- Reserva persistente por campana/telefono en `whatsapp_messages.id`, antes del POST a Meta. Los intentos repetidos, concurrentes o inciertos quedan bloqueados para revision; no hay reintentos automaticos.
- Un resultado aceptado por Meta no equivale a entregado/leido. Los estados finales llegan por webhook.
- Ante fallos parciales solo los destinatarios aceptados se marcan enviados; el resto de la campana queda pendiente.

En las plantillas de catalogo se puede indicar opcionalmente el ID de producto de Meta para la miniatura. Sin ese dato, Meta elige el primer producto. El boton abre el catalogo completo, no un filtro de marca. Fuente: https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalog-template-messages

Pruebas sin envios reales: `node --experimental-strip-types --test scripts/test-whatsapp-meta.mjs`. Publicar frontend y los tres archivos afectados de `crm-agent` por separado, con respaldo. No requiere migracion.

## Webhook

La URL del webhook debe apuntar al endpoint del backend:

```text
/functions/v1/crm-agent/whatsapp-webhook
```

Meta usa:

- `GET` para verificacion inicial con `hub.challenge`.
- `POST` para mensajes entrantes y estados.

El backend debe guardar eventos crudos en `whatsapp_webhook_events`, actualizar `whatsapp_messages` y crear interacciones comerciales cuando el cliente responde.

## Consentimiento

Para campanas comerciales masivas, cada empresa debe tener:

```text
whatsapp_opt_in = true
```

Si no existe consentimiento, el envio queda bloqueado. Los estados `opt_out`, `bloqueado`, `invalido` y `no_contactar` tambien impiden enviar. Nunca cambiar el consentimiento para probar la integracion.
