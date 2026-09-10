# DeepSeek Web: worker comercial

El worker se mantiene en otro repositorio del mismo CRM:
`https://github.com/msanhueza237-creator/agente-inteligente-comercial.git`.
Este overlay versiona el cambio coordinado sin copiar todo ese proyecto al CRM.

Base verificada: `3ae811f705944ad662bfc6aaecb41721ab7e2e6c`.
Archivo: `deepseek-web.patch`. No incluye secretos, Docker Compose ni contabilidad.

## Aplicacion

1. Verificar `git rev-parse HEAD` y `git status --short` en el repo comercial.
   Conservar sus cambios existentes, especialmente `docker-compose.yml`.
2. Ejecutar `git apply --check <ruta-absoluta-al-patch>` antes de aplicar.
   Si hay divergencias, revisar: no usar reset ni forzar el parche.
3. Ejecutar `git apply <ruta-absoluta-al-patch>`.
4. Ejecutar `pytest tests/test_deepseek_discovery.py tests/test_authorized_sources.py
   tests/test_http_crm.py tests/test_worker.py tests/test_contracts_and_expansion.py`.
5. Publicar una nueva imagen del worker mediante su despliegue existente,
   conservando el archivo de composicion y configuracion privada del servidor.

No basta copiar archivos al contenedor: desaparecerian al reiniciarlo.
La publicacion del worker requiere la misma autorizacion que el CRM.

Para una publicacion coordinada sin actualizar dependencias, el Dockerfile de
este directorio admite `BASE_IMAGE` fijada a una imagen previa respaldada y
verificada. Si los servicios comparten `clima-activa-agent:latest`, conservar
tambien las correcciones vigentes de hub-worker: comparar los archivos de
prospeccion entre ambas imagenes antes de elegir la base comun. No reemplazar
la etiqueta compartida por una imagen que retroceda Finanzas.
Usar
`CRM_REVISION` al commit del CRM. Su contexto contiene solo los seis archivos
Python parcheados; no se incluyen .env ni credenciales. Publicar esa imagen como
`clima-activa-agent:latest` y ejecutar `docker compose up -d --no-deps --no-build
worker` conserva los demas servicios, la base y las migraciones del agente.
El parche queda aplicado tambien en el checkout del servidor. Un despliegue
futuro del repositorio comercial debe incorporar este parche, o verificar que
ya haya sido integrado upstream, antes de reemplazar la imagen.

## Contrato

- El claim anuncia `deepseek_web_v1` y `deepseek_candidates_v2`; admite 65 segundos.
- `deepseek_discoveries` sobrevive la validacion Pydantic del snapshot.
- Los hallazgos no traen telefono, direccion ni evidencia atribuida a Brave.
- Solo la lectura del sitio oficial aporta campos verificados. El nombre SEO
  inicial se reemplaza por el nombre encontrado en ese sitio, no por IA.
- La deduplicacion, limites por tarea/campana y aprobacion humana se mantienen.
- Los workers v2 guardan primero los hallazgos como candidatos pendientes y
  consumen la cola durable de investigacion entre tareas, sin pasar por Copiloto.
- Cada validacion usa una consulta Brave con el presupuesto mensual existente,
  seguida del sitio oficial y el territorio completo del snapshot de campana.
- Si Brave falla, el candidato permanece visible y se registran reintentos
  acotados. Los campos de directorios no habilitan importaciones.

## Publicacion de candidatos pendientes

Aplicar `supabase/prospecting_discovery_candidates.sql` despues de las
migraciones `prospecting_deepseek_search.sql` y `prospecting_enrichment.sql`.
Luego publicar `crm-agent` y el worker v2. No afecta contabilidad.
El esquema nuevo conserva los RPC existentes y protege tambien la aprobacion
por contacto. Una busqueda no crea empresas ni destinatarios comerciales.

Para recuperar hallazgos ya auditados, invocar como administrador de servicio
`stage_prospecting_discoveries(run_uuid)` para la ejecucion autorizada. La
operacion es idempotente, respeta el limite congelado y no consulta DeepSeek
otra vez. No ejecutar reintentos masivos ni modificar snapshots historicos.
Los hallazgos pueden ser directorios o productos: son candidatos de revision,
no empresas verificadas. La validacion mantiene visibles los no confirmados.

Rollback: restaurar la imagen anterior y desactivar DeepSeek en las campanas;
conservar auditoria y evidencia. No borrar ejecuciones ni reservas.
