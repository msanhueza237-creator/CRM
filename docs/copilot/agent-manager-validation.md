# Validacion del Gerente multiagente

Fecha: 2026-09-16. Registro de validacion previa al despliegue. Implementacion
local verificada y mensaje del commit confirmado por el usuario. No hay migraciones.

## Pruebas automatizadas

138 pruebas aprobadas:

- Copiloto original: 57.
- Copiloto empresarial: 13.
- Voz Live: 20.
- Contratos de agentes, permisos, informes y correo programado: 27.
- Gerente nuevo: 21, incluyendo ruta HTTP texto/voz, contexto, permisos de modulo,
  fallo parcial, timeout, duplicados, trazabilidad y bloqueo de herramientas de envio.

Typecheck del backend y build de produccion aprobados. Vite conserva una advertencia
de bundles grandes del CRM existente; no impide compilar. No se modifica el codigo
de WebRTC ni el transporte Live.

## Lecturas reales

Se ejecutaron Responses con el modelo configurado del servidor y herramientas
reales contra Supabase/servicios del CRM, con identidad administrativa comprobada.
Estas pruebas no escriben conversaciones ni datos empresariales en produccion.
Los resultados detallados quedan en archivos temporales locales excluidos del commit.

| Pregunta | Delegacion observada | Resultado |
| --- | --- | --- |
| Cuanto vendimos este mes | Finanzas | Ventas y resultado, con advertencias de costos/asientos pendientes |
| Pendiente de cobrar | Cobranza | Cartera y cheques; detecta diferencia entre detalle y tablero, sin sumarlos |
| Productos con poco stock | Logistica | SKU y stock, distingue fecha de origen y universo/pagina |
| Mercaderia de China | Comercio Exterior | Operacion y detalle de productos, sin dar ETA por confirmada |
| Proxima importacion | Comercio Exterior | Productos, costos y fechas; alerta datos antiguos y valores discrepantes |
| Instagram y Facebook | Marketing | Publicaciones y programacion reales; metricas parciales declaradas |
| Principales clientes | Comercial | Ranking documental con NC y cobertura explicita |
| Resumen general | Los seis especialistas | Una respuesta consolidada con prioridades; 47 segundos en repeticion |
| Analisis transversal completo | Los seis especialistas | Una respuesta con todas las areas; 106 segundos en repeticion |

Se detecto y corrigio una exploracion innecesaria de documentos pagados en Cobranza.
La repeticion transversal completo los seis especialistas, sin timeout de agente.
Hay fuentes parciales y consultas demasiado amplias que el sistema identifica
como tales; no se convierten en ceros ni datos inventados. La latencia del informe
transversal todavia requiere seguimiento y mejoras con las trazas de produccion.

Se verifico ademas una secuencia real de tres preguntas con contexto compartido:
septiembre -> agosto -> comparacion. Conserva los meses, vuelve a leer las fuentes
y advierte que septiembre esta incompleto. No confunde ventas con caja.

## Seguridad y regresion

- Hashes de 1.862 asientos y 4.062 lineas contables sin cambios antes/despues.
- Ningun envio, publicacion, cambio de stock, precio o dato financiero.
- Sin claves en frontend, fuentes, documentacion ni resultados.
- Permisos del perfil, de Contenido y de Comercio Exterior comprobados en servidor.
- Memoria y sesiones de voz conservan validacion de propietario, rol y delegacion.
- Correos del Gerente: contrato y compuerta diaria probados sin enviar correo real.
- UI comprobada en escritorio y viewport movil 390x844; tabla administrativa con
  desplazamiento propio, sin desbordamiento horizontal de la pagina.
- La prueba visual local reutiliza respuestas de lectura, no simula haber publicado.

## Publicacion y pendientes

Respaldo previo preparado en el VPS:
`/root/crm-deploy-backups/agent-manager-20260916`.
Incluye funciones originales, imagen frontend anterior y hashes contables.
El respaldo se preparo antes de instalar el release y antes del commit/push.
La comprobacion de produccion se realiza despues de esa publicacion.

Variables nuevas opcionales: COPILOT_AGENT_MANAGER_ENABLED,
COPILOT_MANAGER_TIMEOUT_MS, COPILOT_SPECIALIST_TIMEOUT_MS. No se requieren nuevas
credenciales. OPENAI_REASONING_MODEL y configuracion Live existentes se conservan.

Despues de publicar: comprobar endpoint, auditoria administrativa, assets,
conversacion consolidada y conexion de voz en produccion. La experiencia fisica
de hablar/interrumpir desde Android requiere prueba con el usuario; no se afirma
haberla realizado desde una emulacion de viewport.

Etapa 2: medir latencia, costo por pregunta y cobertura por agente; reducir lecturas
repetidas y evaluar modelos sobre un conjunto de preguntas verificadas. No se
implemento un router Luna/Sol. Tampoco se habilitaron escrituras conversacionales:
las acciones siguen en sus modulos con las confirmaciones existentes.
