# Gmail API integration - CRM LatinChile

Esta guia configura Gmail API para enviar correos desde:

`msanhueza@latinchile.cl`

La integracion no usa SMTP. El frontend no recibe Client Secret, refresh token ni access token. Todo envio pasa por la Edge Function `gmail-integration`.

## 1. Google Cloud Console

1. Entra a Google Cloud Console.
2. Crea o selecciona un proyecto para LatinChile CRM.
3. Habilita **Gmail API**.
4. Configura la pantalla de consentimiento OAuth.
5. Agrega como usuario de prueba la cuenta `msanhueza@latinchile.cl` si la app esta en modo testing.
6. Crea credenciales **OAuth client ID** tipo Web Application.

## 2. Redirect URI

La URL debe apuntar al callback del backend seguro.

Local con Supabase Edge Function:

```text
http://127.0.0.1:54321/functions/v1/gmail-integration/callback
```

Produccion futura con Supabase Edge Function:

```text
https://TU-PROYECTO.supabase.co/functions/v1/gmail-integration/callback
```

Si necesitas conservar rutas del dominio del CRM, configura un proxy/rewrite en Dokploy/Nginx:

```text
https://crm.latinchile.cl/api/integrations/gmail/callback
```

Ese proxy debe reenviar internamente a:

```text
https://TU-PROYECTO.supabase.co/functions/v1/gmail-integration/callback
```

## 3. Variables de entorno

Configura estas variables como secretos de la Edge Function, no en el frontend:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
GOOGLE_GMAIL_SENDER=msanhueza@latinchile.cl
GMAIL_TOKEN_ENCRYPTION_KEY=
CRM_APP_URL=http://localhost:5173
```

En produccion:

```env
CRM_APP_URL=https://crm.latinchile.cl
```

`GMAIL_TOKEN_ENCRYPTION_KEY` debe ser una cadena larga y privada. Cambiarla invalida la capacidad de descifrar tokens ya guardados.

## 4. Supabase SQL

Ejecuta:

```text
supabase/gmail_integration.sql
```

Crea:

- `gmail_integrations`
- `gmail_oauth_states`
- `email_campaigns`
- `email_campaign_recipients`
- `email_messages`

## 5. Flujo de conexion

1. Entra al CRM como administrador.
2. Abre **Administracion > Integracion Gmail**.
3. Presiona **Conectar Gmail**.
4. Google debe mostrar la cuenta `msanhueza@latinchile.cl`.
5. Si se conecta otra cuenta, el backend rechaza la conexion.
6. Al volver al CRM, revisa estado y envia correo de prueba.

## 6. Scopes

Se usa Gmail send:

```text
https://www.googleapis.com/auth/gmail.send
```

Tambien se solicita `openid email` para validar que la cuenta conectada sea exactamente `msanhueza@latinchile.cl`. No se leen correos.

## 7. Prueba de envio

Desde Administracion:

1. Escribe un correo de prueba.
2. Presiona **Enviar prueba**.
3. Revisa `email_messages` y el estado en pantalla.

Desde Campanas:

1. Crea o selecciona una campana tipo `email` o `mixta`.
2. Revisa segmento, destinatarios y vista previa.
3. Presiona **Enviar via Gmail API**.
4. Confirma el envio.
5. Revisa resultados y ficha de empresa.

## 8. Entregabilidad

- Parte con bajo volumen.
- Segmenta por tipo, ciudad, estado comercial o prioridad.
- Personaliza variables como `{{nombre_empresa}}` y `{{nombre_contacto}}`.
- Evita asuntos agresivos o promesas exageradas.
- Incluye datos claros de contacto de Clima Activa / LatinChile.
- Para campanas recurrentes, agrega baja/desuscripcion antes de escalar volumen.
