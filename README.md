# Clima Activa CRM

Aplicacion web CRM para gestionar prospectos, distribuidores, tiendas comerciales, tecnicos e instaladores grandes de Clima Activa.

## Stack

- React + TypeScript + Vite
- Supabase Auth, Postgres y Storage
- CSS modular sin framework obligatorio
- Preparado para Dokploy en VPS Hostinger

## Ejecutar local

```bash
npm install
cp .env.example .env
npm run dev
```

Si `.env` no tiene credenciales reales de Supabase, la app abre en modo demo local. Puedes entrar con:

- Email: `admin@climactiva.local`
- Contrasena: `demo1234`

## Supabase

1. Crear un proyecto en Supabase.
2. Copiar `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` en `.env`.
3. Ejecutar `supabase/schema.sql` en el SQL editor.
4. Crear el primer usuario desde Supabase Auth.
5. Insertar su registro en `profiles` con rol `administrador`.

## Despliegue con Dokploy

1. Subir el repositorio a GitHub o GitLab.
2. En Dokploy, crear una aplicacion desde el repo.
3. Build command: `npm ci && npm run build`
4. Output directory: `dist`
5. Variables de entorno:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_APP_ENV=production`
6. Publicar como sitio estatico o servir `dist` con Nginx.

## Modulos incluidos en esta base

- Login con Supabase o modo demo.
- Rutas protegidas.
- Layout profesional con sidebar y header.
- Dashboard comercial.
- Listado y ficha de empresas.
- Historial comercial.
- Campanas con confirmacion manual antes de envio.
- Plantillas con variables.
- Administracion inicial.
- Esquema SQL inicial para Supabase.

## Siguientes etapas

1. Conectar CRUD real de empresas a Supabase.
2. Crear formularios de alta/edicion con validacion.
3. Implementar politicas RLS completas por rol.
4. Agregar importacion CSV/Excel.
5. Integrar correo SMTP/Gmail y WhatsApp Business API con confirmacion administrativa.
