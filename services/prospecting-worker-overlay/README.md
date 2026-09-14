# Google Places y DeepSeek Pro: worker comercial

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
   `pytest tests/test_google_first.py tests/test_native_research.py tests/test_deepseek_discovery.py tests/test_prospecting_site_quality.py tests/test_secure_web_scraper.py tests/test_authorized_sources.py tests/test_http_crm.py tests/test_worker.py tests/test_contracts_and_expansion.py tests/test_integration_monitor.py tests/test_quality_gate.py`.
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

## Contrato Google First

- El worker anuncia `google_first_research_v1`. El claim no consulta al proveedor.
- Nuevos runs con Places y DeepSeek congelan `discovery_strategy=google_places_first`.
  Solo generan tareas Google, por keyword y comuna. DeepSeek analiza cada hallazgo
  en la cola persistente, incluso si Google ya proporciona un sitio oficial.
  Los snapshots anteriores no cambian y conservan su flujo historico.
- Se planifican al menos 5 consultas complementarias por tarea (6 por defecto),
  con paginas de 20 resultados y hasta 3 paginas por consulta. Google Places New
  admite hasta 60 resultados por consulta; no equivale a 5 paginas del buscador
  Google. Se detiene ante ausencia de nextPageToken o presupuesto agotado.
  Referencia: https://developers.google.com/maps/documentation/places/web-service/text-search
- POST `prospecting-runs/:run/google-discoveries` persiste pistas con Place ID,
  lease de run y tarea Google comprobados. Deduplica por Place ID dentro del run.
  Guarda tambien pistas sin detalles cuando se alcanza el presupuesto o el tope
  de consultas de detalle; no las descarta por carecer aun de contacto o actividad.
  No se supera el limite de candidatos de la campana. La evidencia Google caduca
  en 30 dias mediante el purgado existente; no se duplica en discovery_origin.
- El analisis `climactiva-google-v1` queda auditado por candidato; una seleccion
  vacia no habilita volver al sitio original ni aprobar. El guard SQL exige
  analisis positivo mas verificacion oficial public-web-v4 para la importacion.
- POST `prospecting-runs/:run/research` recibe operation_id, kind, worker_id y
  lease_token. Solo el servidor descifra la clave DeepSeek.
- La reserva SQL impide repetir una llamada pagada por el mismo operation_id.
- V4 Pro con razonamiento alto; hasta tres consultas web por etapa de
  descubrimiento y dos por investigacion del sitio oficial.
- Hasta 12 etapas de descubrimiento por ejecucion; 20 solicitudes diarias
  exclusivamente de descubrimiento. El analisis no tiene tope diario interno:
  una reserva por candidato de la cola, incluidos todos los pendientes.
  Se respeta el limite de resultados de la tarea
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
  Todos es la vista inicial; los pendientes y fuera de alcance conservan
  su historial sin presentarse como oportunidades verificadas. Los contadores
  separan contactables por revisar, pendientes, fuera de alcance, revisados y
  rechazados usando la misma clasificacion que los filtros.
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
- `ResearchDeferred` pausa la investigacion cuando el servidor confirma saldo
  insuficiente o limite temporal del proveedor. No consume un intento de candidato.
  No existe un tope diario ni acumulado de validaciones por ejecucion.
- `enrichment_pause` conserva el motivo de pausa. El worker libera las antiguas
  pausas DAILY_LIMIT con auto_resume=true sin esperar al dia siguiente.
  Las pausas manuales/historicas sin programacion, cancelaciones, saldo insuficiente
  y errores del proveedor no se reactivan automaticamente. Reanudar devuelve el
  estado real. No modifica la clave ni recarga saldo; no es un limite monetario.
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
Aplicar tambien `supabase/prospecting_google_first.sql` DESPUES de native_research.
Versionar API, worker (incluido budget.py), ambos SQL e interfaz como conjunto.
El cambio de capacidad impide que el worker anterior tome los nuevos trabajos.
No publicar solo la interfaz ni editar snapshots activos para cambiar de motor.

Publicar juntos SQL, `crm-agent` (incluido prospecting-research.ts y sus
dependencias), `crm-copilot/prospecting-report.ts`, worker Google First e interfaz.
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
