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
este directorio admite `BASE_IMAGE` fijada a la imagen previa respaldada y
`CRM_REVISION` al commit del CRM. Su contexto contiene solo los cuatro archivos
Python parcheados; no se incluyen .env ni credenciales. Publicar esa imagen como
`clima-activa-agent:latest` y ejecutar `docker compose up -d --no-deps --no-build
worker` conserva los demas servicios, la base y las migraciones del agente.
El parche queda aplicado tambien en el checkout del servidor. Un despliegue
futuro del repositorio comercial debe incorporar este parche, o verificar que
ya haya sido integrado upstream, antes de reemplazar la imagen.

## Contrato

- El claim anuncia `capabilities=["deepseek_web_v1"]` y admite 65 segundos.
- `deepseek_discoveries` sobrevive la validacion Pydantic del snapshot.
- Los hallazgos no traen telefono, direccion ni evidencia atribuida a Brave.
- Solo la lectura del sitio oficial aporta campos verificados. El nombre SEO
  inicial se reemplaza por el nombre encontrado en ese sitio, no por IA.
- La deduplicacion, limites por tarea/campana y aprobacion humana se mantienen.
- Si Brave falla, se procesan los sitios DeepSeek y se registra el fallo.

Rollback: restaurar la imagen anterior y desactivar DeepSeek en las campanas;
conservar auditoria y evidencia. No borrar ejecuciones ni reservas.
