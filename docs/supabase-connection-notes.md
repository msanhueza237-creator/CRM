# Notas de Conexion Supabase Self-hosted

Estas notas resumen la configuracion recibida para conectar el CRM a Supabase sin guardar secretos sensibles en el repositorio.

## URL publica

Supabase esta publicado en:

```text
http://crm-climactiva-supabase-ff88c0-187-77-53-52.sslip.io
```

Para el frontend Vite, usar:

```env
VITE_SUPABASE_URL=http://crm-climactiva-supabase-ff88c0-187-77-53-52.sslip.io
VITE_SUPABASE_ANON_KEY=usar_la_anon_key_del_panel
```

Importante: solo la `ANON_KEY` puede ir al frontend. La `SERVICE_ROLE_KEY`, passwords, JWT secret, vault key y claves internas no deben usarse en React ni subirse al repositorio.

## Puertos

El conflicto anterior de puerto 5432 fue corregido con:

```env
POSTGRES_PORT=5433
POOLER_PROXY_PORT_TRANSACTION=6544
```

Mantener esos puertos si existe otro Postgres/Supabase en el VPS.

## Auth y redirecciones

La app local de Vite normalmente usa:

```text
http://localhost:5173
```

Por eso conviene agregarlo en Supabase:

```env
SITE_URL=http://localhost:5173
ADDITIONAL_REDIRECT_URLS=http://localhost:5173/*,http://crm-climactiva-supabase-ff88c0-187-77-53-52.sslip.io/*
```

Cuando el CRM tenga dominio propio, reemplazar/agregar ese dominio como `SITE_URL` principal.

## Email

Actualmente la configuracion tiene SMTP falso y:

```env
ENABLE_EMAIL_AUTOCONFIRM=false
```

Con esa combinacion, el alta/login con confirmacion por email puede fallar porque Supabase intentara enviar correos con un SMTP no real.

Opciones para desarrollo:

- Configurar SMTP real.
- O activar temporalmente `ENABLE_EMAIL_AUTOCONFIRM=true`.

## Seguridad

Antes de produccion:

- Rotar secretos si fueron compartidos fuera del servidor.
- Usar HTTPS en `SUPABASE_PUBLIC_URL` y `API_EXTERNAL_URL`.
- No exponer Postgres publicamente si no es necesario.
- Mantener `SERVICE_ROLE_KEY` solo en backend seguro, nunca en frontend.
