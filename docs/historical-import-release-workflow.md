# Publicacion durante la transicion del importador historico

Propuesta pendiente de autorizacion operativa. No se ha cambiado Dokploy.

## Cloud -> GitHub -> VPS

- CRM: msanhueza237-creator/CRM, rama de publicacion fix/historical-import-cloud.
- Backend: msanhueza237-creator/agente-inteligente-comercial, rama propuesta
  codex/historical-import-app-only, con el Compose que contiene solo app.
- No crear proyectos ni agentes nuevos. No merge/push a main en esta transicion.
- Ambos recursos existentes de Dokploy quedaran con autoDeploy=false si se
  autoriza la publicacion. Un push o fusion de PR NO pone cambios en produccion.

1. Cloud parte de la rama de publicacion actual y prepara el cambio en una rama
   de trabajo. El PR apunta a esa rama de publicacion, no a main atrasado.
2. Revisar diff, pruebas, dependencias y archivos de despliegue. Aprobar el PR y
   registrar SHA final; rechazar cambios ajenos al alcance.
3. Solicitar la promocion operativa de ese SHA en Dokploy existente. Esta fase se
   realiza desde el VPS/Cloud con acceso seguro; no depende de un servicio Windows.
   Si Cloud carece de acceso a produccion, entrega PR/SHA para la promocion y no
   afirma haber desplegado. No transmitir credenciales al panel HTTP:3000.
4. Antes de reemplazar servicios: comprobar concurrencia y preparar/validar
   imagenes privadas de recuperacion de app y frontend, con hashes y arranque
   aislado. Sin recuperacion verificada, detenerse.
5. Backend primero: construir y probar aparte la imagen app. El despliegue usa
   su ID inmutable, --no-deps --no-build --pull never app; nunca el Compose general,
   migrate, workers o --remove-orphans. Archivos fuera del overlay de cuatro
   modulos requieren revisar explicitamente el empaquetado antes de publicar.
6. CRM: compilar el SHA aprobado con
   VITE_HISTORICAL_IMPORT_URL=https://importaciones.latinchile.cl. Conservar las
   otras variables. Verificar checkout final, imagen, HTML/assets y preview
   sintetico sin Guardar. El navegador no debe llamar a localhost.
7. Registrar SHA, imagen, despliegue, pruebas y recuperacion. Una publicacion
   futura exige nuevamente revision y autorizacion; no usar esta para otros cambios.

El procedimiento completo de reversibilidad y fallos esta en el repositorio del
agente, docs/historical-import-operations.md. Incluye recuperar solo las imagenes
y configuraciones afectadas, nunca restaurar bases o el VPS ni detener workers.

## Salida de las ramas transitorias

Volver a main requiere PRs de consolidacion que incluyan todas las mejoras y las
reglas de despliegue seguro, seguido de autorizacion para cambiar rama/autodeploy.
No apuntar Dokploy a un main que aun no contenga estos cambios. No habilitar ahora
webhooks, workflows o tokens nuevos de despliegue automatico.

El importador pasa al VPS, pero la automatizacion contable Facto mediante Chrome
local no forma parte de esta publicacion y mantiene su dependencia del PC.
