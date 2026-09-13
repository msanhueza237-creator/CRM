# DeepSeek Pro: worker comercial v3

El worker vive en `https://github.com/msanhueza237-creator/agente-inteligente-comercial.git`.
Este overlay versiona la integracion coordinada, sin copiar el repositorio ni secretos.
Base: `3ae811f705944ad662bfc6aaecb41721ab7e2e6c`.

## Aplicacion y pruebas

1. Revisar HEAD y cambios existentes del worker. Conservar Facto, hub-worker,
   Docker Compose y configuracion privada.
2. Ejecutar `git apply --check <ruta/deepseek-web.patch>` contra la base.
   No forzar si el parche v2 ya esta instalado: comparar el resultado v3 y
   actualizar solo los archivos incluidos. No usar reset.
3. Aplicar el parche y ejecutar:
   `pytest tests/test_native_research.py tests/test_deepseek_discovery.py tests/test_prospecting_site_quality.py tests/test_secure_web_scraper.py tests/test_authorized_sources.py tests/test_http_crm.py tests/test_worker.py tests/test_contracts_and_expansion.py tests/test_integration_monitor.py tests/test_quality_gate.py`.
4. Construir una imagen con el Dockerfile de este directorio, BASE_IMAGE fijada
   a una imagen previa verificada y CRM_REVISION al commit publicado.
   El contexto contiene solamente los archivos Python indicados por COPY, sin .env.
   Los archivos de pruebas y fake.py van al checkout, no al contenedor.
5. Conservar las correcciones de Facto en la imagen base. Si varios servicios
   comparten etiqueta, no sustituirla por una imagen que retroceda hub-worker.
   Reiniciar solo el worker de prospeccion con su mecanismo habitual.

No basta editar archivos dentro del contenedor: se perderian al reiniciar.
Actualizar tambien el checkout del servidor; un despliegue posterior debe
integrar o conservar el overlay.

## Contrato v3

- El worker anuncia `deepseek_research_v3`. El claim ya no consulta al proveedor.
- DeepSeek tiene prioridad sobre Places; cada tarea corresponde a rubro y comuna.
- POST `prospecting-runs/:run/research` recibe operation_id, kind, worker_id y
  lease_token. Solo el servidor descifra la clave DeepSeek.
- La reserva SQL impide repetir una llamada pagada por el mismo operation_id.
- V4 Pro con razonamiento alto; hasta tres consultas web por etapa de
  descubrimiento y dos por investigacion del sitio oficial.
- Hasta 12 etapas de descubrimiento por ejecucion; 20 solicitudes diarias
  compartidas con validaciones. Se respeta el limite de resultados de la tarea
  y de candidatos de la campana. El saldo USD se consulta antes de pagar:
  se requiere al menos US$0,25. No es un presupuesto mensual exacto ni una
  reserva monetaria; el proveedor es la fuente de facturacion.
- Los hallazgos reales de la herramienta web se guardan en Candidatos.
  Los perfiles sociales se distinguen por URL, no por dominio compartido.
- `business-selection-v1` selecciona empresas del pais, territorio y tipo
  solicitados entre resultados reales. Directorios, empleo y paginas extranjeras
  no se convierten en empresas. Un dominio oficial se guarda una sola vez por run.
- `public-web-v4` verifica identidad consistente, contacto propio, actividad y
  domicilio en la campana. No mezcla datos de productos, personas o directorios.
  Contactables es la vista inicial; los pendientes y fuera de alcance conservan
  su historial sin presentarse como oportunidades verificadas.
- Perfil Climactiva: once frases de tiendas, distribuidores, servicios,
  mantencion, reparacion, instalaciones y proyectos residenciales, comerciales
  e industriales. El formulario carga todos los tipos territoriales; aplicar
  el perfil a una definicion existente solo cambia su borrador, no sus runs,
  comunas, fuentes o limites. El inicio sigue siendo manual.
- `quality.py` reconoce comercios de refrigeracion y empresas de servicios HVAC
  sin exigir una tienda a los prestadores de servicios. Campanas exclusivamente
  comerciales conservan el filtro de tipos. Las palabras de busqueda no cuentan
  como evidencia de actividad ni de capacidad de compra.
- Alcance fijo Climactiva: solo climatizacion, refrigeracion y aire acondicionado
  residencial/comercial/industrial. DeepSeek recibe sector=hvac incluso ante
  palabras genericas; la validacion rechaza otros rubros y usuarios finales
  aunque tengan contacto y domicilio. No basta que un negocio tenga climatizacion.
- La ficha de visita usa actividad oficial y contactos verificados. Volumen,
  proyectos vigentes, responsable de compras y horario quedan por confirmar.
- `ResearchDeferred` pausa la investigacion cuando el servidor confirma limite
  diario, limite de ejecucion, saldo insuficiente o limite del proveedor. No
  consume un intento de candidato; no eleva presupuestos ni recarga saldo.
- No se importan telefonos/correos generados por IA. Solo evidencia del sitio
  oficial permite validar identidad, domicilio y contacto. Los no confirmados
  permanecen visibles y no pueden aprobarse.
- Brave queda sin llamadas, incluyendo pruebas de conexion antiguas.
  No se cancela su suscripcion ni se borra la atribucion historica.
- Copiloto consulta los resultados y fuentes; no es un paso del proceso.

## Despliegue coordinado

Aplicar `supabase/prospecting_native_research.sql` despues de
`prospecting_deepseek_search.sql`, `prospecting_enrichment.sql` y
`prospecting_discovery_candidates.sql`. Es una migracion de Prospeccion,
no de Finanzas. Migra fuentes de campanas actuales; conserva snapshots y
evidencia historicos. El SQL puede aplicarse de nuevo.
Aplicar despues `supabase/prospecting_quality_pause.sql`. La version v4 del
validador, el guard SQL y el selector API deben publicarse juntos; no activar
el worker v4 con el guard antiguo v3. No reactivar automaticamente la ejecucion
pausada del usuario ni volver a pagar investigaciones antiguas sin revision.

Publicar juntos SQL, `crm-agent` (incluido prospecting-research.ts y sus
dependencias), `crm-copilot/prospecting-report.ts`, worker v3 e interfaz.
Detener nuevas ejecuciones durante la ventana y esperar las activas antes
de cambiar versiones. El nuevo API rechaza workers antiguos ANTES de asignar
un run. Verificar disponibilidad de deepseek-v4-pro con la clave guardada.

La publicacion y una prueba real de pago requieren autorizacion.
Comprobar en una campana acotada: modelo real Pro, consultas auditadas,
candidatos persistidos, validacion publica, ausencia de llamadas Brave,
deduplicacion y revision humana.

Rollback: restaurar funciones, interfaz e imagen previa como conjunto.
Conservar auditoria y reservas. No ejecutar snapshots v3 con un worker v2;
pausar esas ejecuciones, sin borrarlas ni reescribir su evidencia.
