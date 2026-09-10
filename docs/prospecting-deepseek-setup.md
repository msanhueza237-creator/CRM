# DeepSeek API en Prospeccion

## Alcance

Configuracion de credenciales exclusivamente. Un administrador activo puede guardar,
verificar, reemplazar y desconectar su clave desde **Prospeccion > DeepSeek API**.
No inicia busquedas ni conecta DeepSeek al worker comercial. Las fuentes actuales,
campanas, candidatos y su proceso de aprobacion no se modifican.

La verificacion realiza solamente `GET https://api.deepseek.com/models`, con Bearer
token y redirecciones deshabilitadas. No envia datos de clientes ni consultas al modelo.
Contrato oficial: https://api-docs.deepseek.com/api/list-models/

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

No hay credenciales reales incluidas ni una conexion de produccion validada por
las pruebas. Si falta la tabla, funcion o secreto, el formulario informa el bloqueo
y no simula una conexion correcta.

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
- El formulario no activa ejecuciones. La integracion futura de busqueda requiere
  su propio alcance, limites de uso y validacion de evidencia antes de crear candidatos.

## Pruebas

```sh
node --experimental-transform-types --test scripts/test-prospecting-integrations.mjs
npm run test:prospecting
npm run build
```

Interfaz aislada con Playwright, sin trafico externo ni credenciales reales:
`PROSPECTING_UI_URL=http://127.0.0.1:5190 node scripts/test-prospecting-integrations-ui.mjs`.
