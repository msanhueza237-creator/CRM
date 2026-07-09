# Respaldo Version 2.0

Este punto representa la version 2.0 del CRM de Clima Activa, construida sobre la base de `demo-1`.

## Que incluye (ademas de lo ya presente en demo-1)

- Conexion real a Supabase self-hosted (Auth, Postgres, Storage) en VPS con Dokploy.
- Integracion real de Gmail API para envio de campanas (OAuth, backend seguro).
- Integracion WhatsApp Meta Cloud API (esquema y flujo listos, pendiente de numero propio).
- Webhooks de mensajes entrantes (WhatsApp y Gmail) con autocreacion de prospectos.
- Capa de API para agentes externos (`supabase/functions/crm-agent`) con API keys por permiso.
- Campanas con propuestas inteligentes: sugerencias segmentadas, edicion persistente y opcion de eliminar/restaurar cada propuesta.
- Adjuntos en campanas de email (Supabase Storage).
- Dashboard con funnel de conversion real por etapa y panel de conversion por fuente, con filtro por fuente en Empresas.
- Backups automaticos de la base de datos Postgres (cron en el VPS, ver `docs/database-backup-guide.md`).

## Como volver a esta version con git

```bash
git checkout v2.0
```

Para volver al trabajo normal despues:

```bash
git checkout main
```

## Como volver desde el zip

Descomprimir `backups/climactiva-crm-v2.0.zip` en una carpeta nueva y ejecutar:

```bash
npm install
cp .env.example .env
npm run dev
```

Sin credenciales reales de Supabase en `.env`, la app levanta en modo demo local (login `admin@climactiva.local` / `demo1234`).

## Nota

Este zip se genera con `git archive`, por lo que solo incluye archivos versionados: no contiene `node_modules`, `.env`/`.env.local` con credenciales reales, ni ningun secreto.
