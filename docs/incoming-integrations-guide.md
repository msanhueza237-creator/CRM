# Guía de Integración: Mensajes Entrantes (Gmail y WhatsApp) al CRM

Hemos creado dos endpoints de Webhook en la función Edge de Supabase (`crm-agent`) para recibir de forma automática las respuestas de tus clientes y registrarlas directamente en el historial comercial de tu CRM.

---

## 📌 URLs de los Webhooks

Ambas URLs requieren que pases tu API key de Climactiva como parámetro de consulta (`apikey`) o mediante la cabecera `x-climactiva-api-key`.

* **Webhook de WhatsApp:**
  `https://[TU-SUPABASE-PROJECT-ID].supabase.co/functions/v1/crm-agent/whatsapp-webhook?apikey=[TU_API_KEY]`

* **Webhook de Gmail:**
  `https://[TU-SUPABASE-PROJECT-ID].supabase.co/functions/v1/crm-agent/gmail-webhook?apikey=[TU_API_KEY]`

> [!NOTE]
> Puedes encontrar tu `[TU-SUPABASE-PROJECT-ID]` en tu panel de Supabase y tu API Key en la tabla `public.agent_api_keys`.

---

## 🟢 1. Integración de WhatsApp

El webhook de WhatsApp es compatible con formatos de carga estándar de JSON y con el formato nativo de **Twilio** (`application/x-www-form-urlencoded`).

### Opción A: Mediante Twilio (Directo)
Si utilizas un número de WhatsApp de Twilio:
1. Dirígete a la consola de Twilio > **Senders** > **WhatsApp Senders**.
2. Edita tu número y en la sección **"A MESSAGE COMES IN"** selecciona **Webhook**.
3. Pega la URL del Webhook de WhatsApp configurado arriba.
4. Selecciona el método **HTTP POST** y guarda los cambios.

### Opción B: Mediante Make.com o Zapier
Si usas otros proveedores de WhatsApp (como Gupshup, Landbot, WABA, etc.):
1. Crea un escenario en **Make.com**.
2. Añade el módulo de tu proveedor de WhatsApp con el trigger **"Watch Messages"**.
3. Añade el módulo **HTTP > Make a Request**.
4. Configura el módulo HTTP con:
   * **URL:** Tu URL de Webhook de WhatsApp.
   * **Method:** `POST`
   * **Body Type:** `Raw (application/json)`
   * **Content:**
     ```json
     {
       "sender": "{{telefono_del_remitente}}",
       "message": "{{cuerpo_del_mensaje}}"
     }
     ```

---

## ✉️ 2. Integración de Gmail (Vía Make.com / Zapier)

Dado que Gmail no permite webhooks HTTP directos sin una infraestructura compleja de Google Cloud Pub/Sub, la forma más rápida y recomendada es utilizar **Make.com** o **Zapier**:

1. Crea un escenario en **Make.com**.
2. Añade el trigger **Gmail > Watch Emails** (puedes filtrarlo por recibidos, no leídos, o etiquetas).
3. Añade el módulo **HTTP > Make a Request**.
4. Configura el módulo HTTP con:
   * **URL:** Tu URL de Webhook de Gmail.
   * **Method:** `POST`
   * **Body type:** `Raw (application/json)`
   * **Content:**
     ```json
     {
       "sender": "{{from.email}}",
       "subject": "{{subject}}",
       "message": "{{text}}"
     }
     ```

---

## 🧠 Comportamiento Inteligente en el CRM

Cuando entra un mensaje a cualquiera de los dos webhooks, el CRM realiza los siguientes pasos de forma automática:

1. **Búsqueda por Remitente:**
   * **WhatsApp:** Busca en la base de datos si existe alguna empresa o contacto cuyo número de WhatsApp o teléfono coincida con el remitente (el sistema limpiará automáticamente espacios y códigos de país para buscar coincidencia exacta).
   * **Gmail:** Busca en las tablas si el correo electrónico coincide con el de alguna empresa o contacto principal registrado.

2. **Registro de Interacción:**
   * Si encuentra coincidencia, crea una nueva interacción de tipo **WhatsApp** o **Correo** en el **Historial comercial** de esa empresa con la descripción del mensaje.

3. **Autocreación de Prospectos (Inbox Inteligente):**
   * Si el remitente **no coincide** con ninguna empresa o contacto en tu base de datos, el sistema **creará automáticamente una nueva empresa en estado "Prospecto"** llamada `Contacto WhatsApp ([Teléfono])` o `Contacto Email ([Email])` y le asociará la interacción inicial. De esta manera, nunca perderás un cliente potencial.
