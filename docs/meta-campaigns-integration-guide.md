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
META_GRAPH_API_VERSION=v25.0
META_WHATSAPP_PRODUCTION_APPROVED=false
```

No guardes estos valores en `localStorage`, en el frontend, ni en archivos versionados.

`META_WHATSAPP_PRODUCTION_APPROVED` debe permanecer en `false` durante la demo interna. Cambialo a `true` solo cuando Meta confirme la aprobacion para produccion.

## Comprobacion desde el CRM

En `Administracion > WhatsApp Meta` usa **Probar conexion real**. La comprobacion es de solo lectura y no envia mensajes. El CRM informa por separado:

- si el webhook ya recibio eventos;
- si el token, Phone Number ID y WhatsApp Business Account ID responden correctamente en Meta Cloud API;
- si la autorizacion de produccion fue confirmada expresamente.

La respuesta nunca incluye el access token ni el App Secret.

## Uso desde campañas

El modulo de campanas puede enviar:

- Climactiva API Key para autorizar el endpoint.
- Nombre exacto de plantilla Meta.
- Destinatarios.
- Variables de plantilla.
- Confirmacion administrativa para casos sin opt-in.

El backend decide si permite o bloquea el envio segun:

- API key valida.
- Variables Meta configuradas en entorno.
- Plantilla indicada.
- Consentimiento `whatsapp_opt_in`.
- Excepcion administrativa documentada cuando corresponda.

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

Si no existe consentimiento, el envio debe bloquearse salvo excepcion manual de administrador con motivo visible.
