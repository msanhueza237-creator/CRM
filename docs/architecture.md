# Arquitectura propuesta

## Objetivo

Construir un CRM comercial para Clima Activa que permita administrar empresas, contactos, interacciones, campanas, plantillas y seguimientos con una base preparada para crecer hacia automatizaciones controladas.

## Decisiones tecnicas

- Frontend: React + TypeScript + Vite por velocidad local, despliegue simple y buena compatibilidad con VPS/Dokploy.
- Backend gestionado: Supabase para Auth, Postgres, Storage y politicas RLS.
- Estilo: CSS propio para mantener control fino del diseno sin depender de un sistema pesado.
- Datos: modelo relacional normalizado con `companies`, `contacts`, `interactions`, `campaigns`, `campaign_recipients`, `message_templates`, `tags`, `company_tags`, `tasks` y `activity_logs`.
- Seguridad: rutas protegidas en cliente y RLS en base de datos. El cliente nunca debe confiar en permisos solo visuales.

## Etapas de trabajo

### Etapa 1: Base funcional

- Crear proyecto Vite/React/TypeScript.
- Agregar Supabase client y variables de entorno.
- Implementar login y rutas protegidas.
- Crear layout principal con sidebar/header.
- Crear dashboard, empresas, ficha, campanas, plantillas y administracion con datos demo.
- Crear esquema SQL inicial.

### Etapa 2: CRUD real

- Conectar empresas, contactos e interacciones a Supabase.
- Crear formularios de empresa/contacto/interaccion.
- Agregar filtros persistentes, ordenamiento y paginacion.
- Registrar logs de actividad.

### Etapa 3: Campanas

- Crear segmentos guardados.
- Resolver variables de plantillas por destinatario.
- Mostrar vista previa y lista de destinatarios antes de cualquier envio.
- Registrar confirmacion administrativa.
- Integrar proveedores de email/WhatsApp sin envios automaticos no confirmados.

### Etapa 4: Operacion comercial

- Importacion CSV/Excel.
- Tareas y recordatorios por vendedor.
- Indicadores de conversion por fuente, segmento, vendedor y etapa.
- Exportacion de reportes.

### Etapa 5: Produccion

- Configurar dominio.
- Revisar RLS y backups.
- Configurar logs y monitoreo.
- Documentar recuperacion ante fallas.

## Flujo comercial esperado

1. Registrar o importar empresas.
2. Clasificar por tipo, prioridad y estado comercial.
3. Abrir ficha de empresa.
4. Registrar llamadas, correos, WhatsApp, reuniones, cotizaciones y notas.
5. Crear campana segmentada.
6. Elegir plantilla.
7. Revisar destinatarios y mensaje renderizado.
8. Confirmar preparacion o envio.
9. Registrar respuestas y proximos seguimientos.
