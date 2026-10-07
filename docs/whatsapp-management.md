# WhatsApp: conversaciones y plantillas

## Arquitectura

Se conserva `crm-agent`, Cloud API, autenticacion Supabase, perfiles, mensajes, bandeja, lecturas y auditoria existentes. No se crea un agente, un CRM ni un webhook alternativo.

- `/mensajes`: Conversaciones, Plantillas y Configuracion (esta ultima solo para administradores).
- `WhatsAppConversationPolicyService`: ventana de 24 horas desde el timestamp original del ultimo mensaje entrante valido, con comprobacion de remitente y Phone Number ID. Un envio saliente no abre la ventana.
- Conversaciones e historial se actualizan cada 15 segundos mientras la pagina esta visible, incluso al consultar mensajes antiguos. El backend vuelve a verificar la ventana y el consentimiento al enviar.
- Administradores activos gestionan borradores, reglas y sincronizacion. Vendedores activos atienden conversaciones y utilizan versiones aprobadas. Los roles provienen de `profiles`, no de `user_metadata`.
- Los agentes existentes no reciben permisos para enviar automaticamente. El envio exige sesion humana, confirmacion e identificador idempotente.

## Rutas en crm-agent

| Ruta | Metodo | Uso |
| --- | --- | --- |
| `whatsapp-template-management` | GET | Lista local, configuracion sin secretos y registro de variables |
| `whatsapp-template-management` | POST | `save`, `submit`, `sync`, `archive`, `policy`; solo administrador |
| `whatsapp-consent` | POST | Registrar/revocar consentimiento con numero exacto, fuente y evidencia |
| `meta-whatsapp-templates` | GET | Version vigente de Meta para seleccion y envio |
| `meta-whatsapp-conversation` | GET | Historial, ventana, consentimiento y contexto CRM |
| `meta-whatsapp-reply` | POST | Respuesta manual, adjunto o plantilla; sin reintento de resultado incierto |
| `whatsapp-inbox`, `whatsapp-read` | GET / POST | Bandeja y lecturas por usuario existentes |
| `whatsapp-webhook` | GET / POST | Verificacion y eventos firmados de Meta existentes |

`submit` nunca se ejecuta al guardar, sincronizar, migrar o cargar la pagina. Requiere revisar el borrador, confirmar finalidad/categoria y confirmar el envio a Meta. Un rechazo conocido conserva el borrador; un timeout bloquea la repeticion hasta verificar el resultado. Las modificaciones no sustituyen silenciosamente la version aprobada.

## Migracion

`20261007012541_whatsapp_template_management.sql` extiende las tablas existentes de plantillas, configuracion, mensajes, eventos, empresas y contactos. Agrega identidad Meta/WABA/idioma, version local, borrador separado, estado sincronizado, consentimiento y metadatos administrativos. No toca contabilidad ni crea tablas paralelas de mensajes. Las nuevas funciones RPC son exclusivas del backend; se prueba RLS y acceso de vendedores.

Los eventos de entrega preservan el payload original y no retroceden de leido a enviado. Las bajas explicitas se conservan por numero. Un telefono, compra o importacion no concede consentimiento: incluso la fuente COMPRA requiere evidencia explicita.

## Ocho borradores iniciales

| Nombre Meta | Categoria propuesta | Finalidad |
| --- | --- | --- |
| cobranza_factura_pendiente | UTILITY | Factura real pendiente, monto y vencimiento |
| pedido_confirmado | UTILITY | Confirmar un pedido realizado, sin afirmar pago |
| pedido_preparado | UTILITY | Actualizar preparacion de un pedido real |
| pedido_despachado | UTILITY | Transportista y seguimiento de despacho realizado |
| cotizacion_disponible | UTILITY | Responder una solicitud especifica vigente |
| seguimiento_cotizacion | MARKETING | Retomar una oportunidad comercial |
| producto_disponible | MARKETING | Aviso comercial de disponibilidad |
| informacion_comercial | MARKETING | Ofrecer asesoria sobre productos |

Los textos completos y ejemplos ficticios estan en la migracion y son editables en Plantillas. Todos comienzan como BORRADOR, sin ID Meta ni confirmacion de finalidad. Meta determina la categoria final. Nombre/empresa/vendedor se obtienen del CRM; documentos, importes y seguimiento exigen valores revisados, nunca consultas SQL recibidas del navegador.

## Configuracion Meta

Se reutilizan exclusivamente las variables backend existentes: `META_GRAPH_API_VERSION`, `META_WHATSAPP_ACCESS_TOKEN` (o alias existente), `META_WHATSAPP_PHONE_NUMBER_ID`, `META_WHATSAPP_BUSINESS_ACCOUNT_ID`, `META_WHATSAPP_APP_SECRET`, `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN` y `META_WHATSAPP_PRODUCTION_APPROVED`. No hay tokens en frontend, respuestas, localStorage ni auditoria. Un token invalido exige revision/rotacion segura; no se inventa un mecanismo automatico de renovacion.

Permisos: `whatsapp_business_management` para gestionar plantillas y `whatsapp_business_messaging` para mensajes. Se verificaron lectura de WABA, numero, dos plantillas aprobadas y suscripciones existentes. No se probo una aprobacion real porque el usuario debe revisar antes los borradores.

Graph se toma del entorno; no hay fallback antiguo. Las categorias, idiomas y limites de creacion estan en `management_policy`, con revision, fecha y fuente oficial. Una categoria nueva requiere verificar tambien su adaptador de componentes. El editor comercial admite texto, variables posicionales y botones estaticos/respuesta rapida. Formatos avanzados (medios, carruseles, OTP) se importan con su estado pero no se convierten ni se envian como texto comercial; requieren su flujo especifico. AUTHENTICATION nunca se utiliza para reducir el costo de un mensaje comercial. No se fijan tarifas: se conserva `pricing` cuando Meta lo entrega; no recibir precio significa desconocido, no cero.

En Meta Developers, aplicacion Climactiva CRM > WhatsApp > Configuracion > Webhooks > Administrar campos, conservar `messages` y `message_template_status_update`; activar tambien `message_template_quality_update`, `template_category_update` y `message_template_components_update` si aun no estan suscritos. Usar el callback existente `https://supabase.latinchile.cl/functions/v1/crm-agent/whatsapp-webhook`. Esos eventos no contienen necesariamente Phone Number ID: se verifica WABA y firma. Hasta completar las suscripciones adicionales, usar Sincronizar con Meta para importar cambios de calidad/componentes/categoria. Cada envio consulta igualmente el estado vigente en Meta.

Fuentes oficiales revisadas: [Graph versions](https://developers.facebook.com/docs/graph-api/changelog/versions), [template API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api), [template components](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components), [status webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update), [send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages).

## Verificacion sin envios reales

`node --experimental-strip-types --test scripts/test-whatsapp-meta.mjs scripts/test-whatsapp-conversation.mjs scripts/test-direct-messages.mjs scripts/test-whatsapp-inbox.mjs scripts/test-whatsapp-management.mjs`

`node scripts/typecheck-whatsapp.mjs`, `node scripts/test-whatsapp-management-browser.mjs`, `node scripts/test-whatsapp-inbox-browser.mjs`, `npm run build`.

Las pruebas usan respuestas Meta simuladas y PostgreSQL aislado PGlite. La prueba de navegador bloquea todo destino distinto de fixture.invalid. No se envian mensajes, plantillas a aprobacion ni consentimientos ficticios a produccion.
