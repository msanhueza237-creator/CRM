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

Permisos: `whatsapp_business_management` para gestionar plantillas y `whatsapp_business_messaging` para mensajes. El 07-10-2026 se verificaron ambos permisos, lectura de WABA, numero, seis plantillas aprobadas y suscripciones existentes. No se probo una aprobacion real porque el usuario debe revisar antes los borradores.

Graph se toma del entorno; no hay fallback antiguo. Las categorias, idiomas y limites de creacion estan en `management_policy`, con revision, fecha y fuente oficial. Una categoria nueva requiere verificar tambien su adaptador de componentes. El editor comercial admite texto, variables posicionales y botones estaticos/respuesta rapida. Formatos avanzados (medios, carruseles, OTP) se importan con su estado pero no se convierten ni se envian como texto comercial; requieren su flujo especifico. AUTHENTICATION nunca se utiliza para reducir el costo de un mensaje comercial. No se fijan tarifas: se conserva `pricing` cuando Meta lo entrega; no recibir precio significa desconocido, no cero.

En Meta Developers, aplicacion Climactiva CRM > WhatsApp > Configuracion > Webhooks > Administrar campos, conservar `messages` y `message_template_status_update`; activar tambien `message_template_quality_update`, `template_category_update` y `message_template_components_update` si aun no estan suscritos. Usar el callback existente `https://supabase.latinchile.cl/functions/v1/crm-agent/whatsapp-webhook`. Esos eventos no contienen necesariamente Phone Number ID: se verifica WABA y firma. Hasta completar las suscripciones adicionales, usar Sincronizar con Meta para importar cambios de calidad/componentes/categoria. Cada envio consulta igualmente el estado vigente en Meta.

La referencia vigente de [App subscriptions](https://developers.facebook.com/docs/graph-api/reference/app/subscriptions/) indica que las suscripciones de WhatsApp se configuran en el panel de apps, no mediante el POST generico de ese endpoint. No se utiliza un endpoint alternativo inventado. Para este paso se necesita una sesion administrativa de Meta; no se debe pegar un token en el navegador ni en el chat.

Fuentes oficiales revisadas: [Graph versions](https://developers.facebook.com/docs/graph-api/changelog/versions), [template API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-account/message-template-api), [template components](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components), [status webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update), [send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages).

## Verificacion sin envios reales

### Continuidad del hilo al responder una campaña

Una respuesta entrante conserva la empresa y el número del hilo establecido,
aunque existan fichas duplicadas con ese número. Si Meta incluye `context.id`,
se comprueba que corresponda a un mensaje saliente aceptado del mismo número y
a una empresa candidata. Sin esa referencia solo se reutiliza un hilo cuando
el historial completo del número está vinculado a una única empresa y contiene
un saliente aceptado. No se decide por nombre, última empresa o una ventana de
24 horas; la ventana limita el envío y no define la identidad del hilo.

Cuando hay varios hilos posibles y ninguna referencia inequívoca, el mensaje
permanece sin vincular para revisión. Un error al consultar el historial bloquea
la atribución y no crea otra ficha. Esta corrección afecta la recepción futura;
no modifica mensajes ya recibidos sin vínculo. Su reasociación exige verificar
la empresa correcta y aprobar la modificación de los registros existentes.

`node --experimental-transform-types --test --test-concurrency=1 scripts/test-whatsapp-meta.mjs scripts/test-whatsapp-conversation.mjs scripts/test-direct-messages.mjs scripts/test-whatsapp-inbox.mjs scripts/test-whatsapp-management.mjs scripts/test-whatsapp-delivery.mjs scripts/test-whatsapp-catalog.mjs`

`node scripts/typecheck-whatsapp.mjs`, `node scripts/test-whatsapp-management-browser.mjs`, `node scripts/test-whatsapp-inbox-browser.mjs`, `npm run build`.

Las pruebas usan respuestas Meta simuladas y PostgreSQL aislado PGlite. La prueba de navegador bloquea todo destino distinto de fixture.invalid. No se envian mensajes, plantillas a aprobacion ni consentimientos ficticios a produccion.

## Auditoria adicional del 07-10-2026

- App: Climactiva CRM `27753747374263165`; WABA `2282055142597894`; Phone Number ID `1136734189534018`. Graph configurado `v26.0`, version mas reciente en el registro oficial consultado. Token de usuario del sistema valido, sin expiracion programada; esto no impide que Meta lo revoque. No se guarda su valor en esta documentacion.
- Suscripciones verificadas en lectura: `messages` y `message_template_status_update`, ambas v25.0, todavia soportada. Los tres campos adicionales requieren completar el panel de Meta. La sincronizacion manual y la verificacion antes de cada envio permanecen disponibles.
- Ya existen 14 plantillas locales: seis sincronizadas y ocho borradores. La plantilla inicial `informacion_comercial` ya fue aprobada, por lo que no se restablece a borrador ni se duplica. Los textos pendientes se conservan sin enviarlos a aprobacion.
- Se protege la edicion de componentes importados no soportados: medios, catalogo, carrusel, OTP, variables de encabezado o parametros nombrados. Se explica la limitacion y se impide reemplazarlos silenciosamente por texto. El envio de catalogos ya soportado se conserva. Para ediciones avanzadas usar Meta y despues sincronizar; no se afirma soporte completo de esos editores.
- Las variables posicionales importadas generan sus campos de ejemplo y vinculacion. La sincronizacion elimina vinculaciones obsoletas de variables que ya no existen en Meta. Un cambio remoto de componentes vuelve a comprobarse antes de la aprobacion.
- La ventana consulta el ultimo entrante valido, no un recibo ajeno mas reciente ni la ultima pagina de historial. El ultimo saliente de la ficha se consulta independientemente de la paginacion. La baja de un contacto se respeta por numero tambien al abrir desde la empresa sin contactId.
- La recepcion pagina empresas/contactos, preserva notas y telefonos existentes y utiliza identidades deterministas para impedir duplicados por entregas concurrentes. Numeros compartidos por varias empresas quedan visibles sin vincular, sin atribuirlos arbitrariamente ni habilitar el envio hasta resolver su identidad.
- Los envios usan prefijo internacional `+`; no se modifican numeros almacenados ni se envia una prueba real. La tabla de plantillas elimina un ancho minimo global que ocultaba estados en celular.
- No hay tablas, migraciones, variables de entorno, rutas ni agentes nuevos en esta revision. Se reutilizan las migraciones de gestion de plantillas, bandeja y recibos ya aplicadas. Se archiva localmente en lugar de borrar una plantilla en Meta.
- Archivos funcionales revisados/modificados: `src/modules/messages/WhatsAppTemplatesPage.tsx`, `src/modules/messages/whatsapp-management.css`, `supabase/functions/_shared/whatsapp-content.ts`, y en `crm-agent`: `index.ts`, `whatsapp-incoming.ts`, `whatsapp-conversation.ts`, `whatsapp-meta.ts`, `whatsapp-template-model.ts`, `whatsapp-template-manager.ts`. Pruebas ampliadas en `scripts/test-whatsapp-conversation.mjs` y `scripts/test-whatsapp-management.mjs`.
- Verificacion: 97 pruebas de dominio/SQL/webhook con red simulada, typecheck backend y build frontend. Ejecutar pruebas secuencialmente evita sobrecargar memoria con instancias PGlite simultaneas. La revision visual usa un servidor local solo con fixtures, protegido por CSP de mismo origen, en 1280, 390 y 320 px; guardado de borrador, variables, revision previa deshabilitada hasta confirmacion, componentes protegidos y permisos de vendedor. No equivale a una prueba autenticada en produccion.
- Lint general ejecutado: hay fallos preexistentes y en archivos temporales ajenos. Los dos diagnosticos previos en archivos tocados son `no-explicit-any` en el tipo JSON de `whatsapp-content.ts` y una funcion no utilizada ajena a WhatsApp en `index.ts`; no se mezclan refactorizaciones ajenas para ocultarlos.
