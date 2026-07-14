# Despliegue de prospeccion en CRM Clima Activa

Este procedimiento actualiza una instalacion **self-hosted** de Supabase y el
frontend publicado por GitHub/Dokploy. No crea la API key del worker: esa llave
se reserva para el piloto final.

## 1. Respaldo

Ejecutar el respaldo habitual del VPS antes de modificar el esquema. No seguir
si el respaldo termina con error.

## 2. Base de datos desde Supabase Studio

Abrir SQL Editor sobre la base de produccion y ejecutar, uno por vez y en este
orden:

1. `supabase/prospecting_preflight.sql`
2. `supabase/agent_api_keys.sql`
3. `supabase/prospecting.sql`
4. `supabase/prospecting_verify.sql`

Los dos scripts de instalacion son aditivos e idempotentes. El verificador debe
mostrar `installed = true`, 16 regiones activas y 346 comunas activas.

No ejecutar todavia `create_agent_api_key`. La interfaz puede operar y crear
runs pendientes sin conectar el worker.

## 3. Edge Function en Supabase self-hosted

En el VPS, localizar la carpeta del stack Supabase que contiene
`volumes/functions`. Copiar la funcion del repositorio:

```powershell
scp -r ".\supabase\functions\crm-agent" `
  usuario@SERVIDOR:/RUTA/SUPABASE/volumes/functions/
```

Reiniciar exclusivamente el servicio de funciones:

```powershell
ssh usuario@SERVIDOR "cd /RUTA/SUPABASE && docker compose restart functions --no-deps"
ssh usuario@SERVIDOR "cd /RUTA/SUPABASE && docker compose logs --tail=100 functions"
```

La instalacion self-hosted ya entrega `SUPABASE_URL` y
`SUPABASE_SERVICE_ROLE_KEY` al contenedor de funciones. No copiarlas al
frontend ni guardarlas en Git.

## 4. Frontend

En Dokploy configurar como argumentos/variables de build:

```env
VITE_SUPABASE_URL=https://URL-PUBLICA-SUPABASE
VITE_SUPABASE_ANON_KEY=ANON_KEY_PUBLICA
VITE_APP_ENV=production
VITE_DEMO_MODE=false
```

No configurar `VITE_AGENT_LOCAL_URL` en produccion hasta desplegar el agente.
La importacion Excel usa ese servicio normalizador; el resto de `/prospeccion`
queda disponible aunque el worker aun no este conectado.

Para crear el commit y subir exclusivamente los archivos publicables:

```powershell
Set-Location "C:\Users\msanh\OneDrive\Escritorio\CRM climactiva"
.\scripts\publish-prospecting.ps1 -Push
```

Dokploy debe reconstruir la imagen desde `main`. Confirmar que el build recibe
los argumentos Vite anteriores; son valores de compilacion, no variables que
puedan agregarse despues sin reconstruir.

## 5. Verificacion

1. Iniciar sesion con un perfil `administrador`.
2. Abrir `/prospeccion` y confirmar que indica `Datos CRM`, no `Demo local`.
3. Crear un borrador territorial y comprobar que no aparece en `/campanas`.
4. Crear una ejecucion; debe quedar `pendiente` hasta conectar el worker.
5. Abrir `Base historica`; no debe haber empresas/contactos creados por defecto.
6. Revisar los logs de Dokploy, Nginx y del servicio `functions`.

## Rollback

Si falla el frontend, en Git revertir el commit de publicacion y volver a
desplegar. Las tablas nuevas son aditivas: no eliminarlas durante una
incidencia. Detener el poller y dejar los runs pendientes conserva el trabajo.
