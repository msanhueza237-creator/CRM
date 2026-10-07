# Importación histórica sin servicio en el PC

La vista previa CSV/XLSX/XLS se procesa en el normalizador existente del agente
en el VPS. El CRM envía el archivo junto con la sesión del usuario a un origen
HTTPS configurado. No se envían claves de servicio ni credenciales Facto.

El agente valida la sesión contra Supabase Auth y consulta el perfil mediante
esa misma sesión: solo permite perfiles activos `administrador` o `vendedor`.
La vista previa no escribe datos. El guardado mantiene los RPC existentes y la
confirmación explícita del usuario. No se requieren migraciones SQL.

## Configuración, pendiente de aplicar en Dokploy

En el servicio web existente del agente:

- `IMPORT_SUPABASE_URL`: origen HTTPS del mismo proyecto Supabase que usa el CRM,
  sin ruta; por ejemplo `https://supabase.latinchile.cl` tras confirmarlo.
- `IMPORT_SUPABASE_ANON_KEY`: clave pública anon de ese proyecto. No usar
  `SERVICE_ROLE_KEY` ni `CRM_API_KEY`; no guardar valores reales en Git.
- `IMPORT_ALLOWED_ORIGINS`: orígenes permitidos, separados por comas, sin slash
  final; para el CRM publicado, `https://crm.latinchile.cl`.

En los argumentos de compilación del frontend:

- `VITE_HISTORICAL_IMPORT_URL`: origen HTTPS confirmado del normalizador, sin
  ruta. El CRM llama a `/api/historical-imports/preview` en ese origen.

No se ha identificado aún el dominio HTTPS del agente. No inventar uno ni usar
el dominio del CRM salvo que exista una ruta de proxy explícita hacia el agente.
La variable antigua `VITE_AGENT_LOCAL_URL` ya no se utiliza. Si falta la nueva
URL, el CRM informa que el servicio no está configurado y no contacta localhost.
El modo demo sin sesión Supabase no puede enviar archivos al servicio remoto.

El Dockerfile recibe la nueva variable como build argument y usa Node 24 para
cumplir los requisitos de las dependencias Supabase bloqueadas. Cambiar valores
solo en el contenedor Nginx no actualiza un bundle Vite ya compilado.

## Publicación controlada

1. Revisar los cambios en ambos repositorios. Publicar en `main` activa los
   despliegues: requiere autorización expresa, no es una prueba inocua.
2. Antes de reconstruir el agente, identificar la imagen y overlays realmente
   desplegados. El repositorio CRM contiene parches adicionales de Facto y
   prospección; una reconstrucción desde el repo base podría perderlos. Integrar
   la corrección sobre ese estado verificado y conservar el rollback previo.
3. Confirmar un backup reciente de Hostinger y la configuración de recuperación.
   No realizar restauraciones ni borrar volúmenes durante la publicación.
4. Publicar el endpoint del servicio `app` existente con HTTPS válido. Configurar
   el proxy para exponer **solo** `/api/historical-imports/preview` (POST/OPTIONS)
   hacia el puerto interno 8000, sin retirar el prefijo de ruta. No publicar el
   puerto 8000 ni las rutas heredadas `/import`, `/monitor` o `/integrations`.
   La configuración exacta depende del proxy/red actual y debe verificarse antes
   de aplicar. Limitar tamaño de cuerpo (26 MiB con multipart), tiempo y tasa de
   solicitudes en el proxy. CORS no sustituye autenticación ni firewall.
5. Configurar las tres variables del agente y desplegar primero el backend,
   preservando servicios, volúmenes y overlays. Sin ellas, el endpoint se cierra
   con HTTP 503; sin sesión, HTTP 401.
6. Comprobar preflight desde el origen CRM y el rechazo de solicitudes sin
   sesión, antes de reconstruir el frontend con su URL HTTPS final.
7. Con un usuario autorizado, analizar un archivo **sintético** pequeño y
   comprobar la vista previa sin pulsar Guardar. Verificar que el navegador no
   haga ninguna solicitud a localhost y que un perfil visualizador sea rechazado.
   Esta prueba productiva requiere autorización; no se ejecutó en Cloud.

No se ha modificado producción ni configurado un dominio real con este cambio.
La aprobación del código no equivale a aprobación de todos los pasos operativos.

## Validación en Cloud

Desde CRM:

```bash
node --experimental-strip-types --test scripts/test-historical-import-transport.mjs
npm run build
```

Desde el repositorio del agente, usando el entorno de pruebas preparado:

```bash
PYTHONDONTWRITEBYTECODE=1 ENV=test CRM_MODE=fake \
DATABASE_URL=postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/test \
/workspace/.cloud-validation/agent-venv/bin/python -m pytest -q \
  -p no:cacheprovider --disable-socket --allow-unix-socket
```

Los valores de esta prueba son sintéticos. No arranca workers ni usa credenciales
de producción. Los tests verifican sesión, perfil, permisos, rechazo de fallos
Supabase, CORS, límites de archivo y normalización sin escrituras.

Rollback: conservar la configuración/imagen previa para una reversión aprobada.
El frontend antiguo vuelve a depender de localhost; no se considera una solución
a la independencia del PC. No es necesario revertir tablas ni borrar datos.
