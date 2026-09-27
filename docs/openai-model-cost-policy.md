# Politica OpenAI del CRM

## Estado de esta entrega

Implementada inicialmente el 2026-09-16. Esta publicacion del selector incluye
el control de consumo solo en crm-copilot. Contenido y extraccion documental
conservan su implementacion publicada; su migracion al router queda pendiente.
Presupuesto autorizado por el usuario: USD 5 diarios para Responses del CRM.
No se recargo saldo, no se consulto repetidamente OpenAI y no se ejecutaron llamadas reales a modelos.
Las pruebas con proveedor real requieren saldo confirmado y activacion explicita.

La voz Live mantiene su arquitectura, modelo, permisos y telemetria independiente.
El presupuesto descrito NO incluye audio Live, otros proyectos, otros servicios ni llamadas realizadas fuera de este router.
No es un limite de facturacion de la cuenta OpenAI. Para un tope total de cuenta debe existir control adicional en el proveedor.

## Antes y despues

| Componente | Antes | Nuevo valor predeterminado |
| --- | --- | --- |
| Gerente | Configuracion compartida Sol | Luna |
| Comercial | Configuracion compartida Sol | Luna |
| Finanzas | Configuracion compartida Sol | Luna |
| Cobranza | Configuracion compartida Sol | Luna |
| Marketing | Configuracion compartida Sol | Luna |
| Logistica | Configuracion compartida Sol | Luna |
| Comercio Exterior | Configuracion compartida Sol | Luna |
| Copiloto legacy | Default separado | Luna, mismo control de gasto |
| Generacion de contenido / extraccion PDF | Defaults separados | Sin cambio en esta publicacion |
| Reportes programados basados en servicios | Calculos del modulo, sin modelo obligatorio | Sin cambio |
| Audio Live | Configuracion Live existente | Sin cambio |

No se modificaron herramientas, reglas comerciales, permisos de los modulos, correos ni datos financieros.

## Puntos de control

- `supabase/functions/_shared/openai-cost-policy.ts`: modelos, tarifas, limites y modo central.
- `supabase/functions/crm-copilot/model-router.ts`: unico emisor de solicitudes Responses; decide escalamiento, reservas, cuota, cache y consumo.
- `supabase/functions/crm-copilot/model-cost-store.ts`: RPC privadas de presupuesto.
- `supabase/openai_cost_guard.sql`: dos tablas e indices nuevos; no altera tablas contables ni RLS existente.
- `src/modules/admin/AgentDiagnostics.tsx`: consumo y modos temporales, en la zona administrativa existente.

Gerente y especialistas comparten el mismo router por turno. Texto y delegacion de voz atraviesan el mismo Gerente.
Las consultas puntuales conservan su especialista pertinente; no se agregan especialistas solo para gastar llamadas.
Las funciones Responses ajenas al Copiloto aun no pasan por este medidor.

## Condiciones exactas de Sol

Siempre se debe completar primero al menos un intento Luna del agente solicitante.
Maximo una llamada Sol por request, incluyendo todos los especialistas y el Gerente.
La revision Sol es final, sin herramientas, sin nuevo ciclo ni mas delegaciones.

Con `ECONOMY_MODE=true`, la escalada automatica requiere:

1. Respuesta Luna sin texto valido, que no sea un rechazo ni truncamiento por limite de salida, y al menos una fuente CRM completa y verificable; o
2. Luna solicita revision de una inconsistencia, existe una advertencia real de discrepancia en una fuente completa y la pregunta trata de contabilidad, conciliacion, rentabilidad, analisis financiero, decision de importacion o consistencia; o
3. Luna solicita revision critica/compleja, existen al menos dos resultados completos con evidencia y una discrepancia registrada, dentro de esos temas criticos.

Una fuente ausente/parcial nunca se transforma en evidencia completa. Complejidad, longitud, muchos registros, varios modulos o un informe completo no bastan.
Sin economia, una inconsistencia verificada tambien puede escalar fuera de los temas criticos; los otros requisitos siguen vigentes.

Orden manual: iniciar una frase del mensaje actual con `usa Sol`, `analizalo con Sol` o `haz un analisis profundo con Sol`.
Solo el Gerente (o el copiloto sin delegacion habilitada) puede aplicar esa orden. Citas, datos externos, historial y especialistas no la autorizan.
El modo `luna_only`, presupuesto, cuota y maximo por turno prevalecen incluso sobre una orden manual.

Desactivar Sol totalmente: `OPENAI_MODEL_MODE=luna_only` en backend.
Desactivarlo temporalmente: Administracion > Actividad del Gerente > Modo temporal > Luna only, entre 1 y 24 horas, con confirmacion.
`sol_manual` elimina el escalamiento automatico. `OPENAI_SOL_AUTO_ESCALATION=false` mantiene ese techo desde el entorno.
Si no alcanza para Sol, se conserva Luna. No se cobra ni intenta una cadena alternativa.

## Presupuesto, tokens y cuota

- Dia de negocio America/Santiago, incluyendo cambio horario.
- Presupuesto de despliegue USD 5/dia; advertencia al 70%, ambos configurables. No hay monto rigido en el router.
- Cada llamada reserva un maximo conservador antes de contactar al proveedor. Una fila bloqueada serializa reservas entre workers y usuarios.
- Al terminar se reemplaza la reserva por el consumo estimado reportado. Tokens de razonamiento son parte de output; no se cobran dos veces.
- Timeout/red/consumo desconocido conservan la reserva; no se asumen costo cero ni reembolso automatico.
- Los archivos/imagenes reservan un limite conservador de contexto multimodal, no el tamano del base64. Puede bloquearse un PDF grande aunque su costo final resulte menor.
- Un presupuesto ausente o un medidor inaccesible bloquean nuevas llamadas. No existe fallback sin control.
- `insufficient_quota` y errores de cuota equivalentes suspenden nuevos intentos del turno, abortan los que el router pueda cancelar y dejan una suspension persistente para los siguientes requests.
- El administrador debe resolver el saldo y confirmar Rehabilitar API. No hay sondeo automatico ni recarga automatica.
- Al instalar la migracion, la suspension inicia activa porque el estado conocido de la cuenta es cuota agotada.
- Cero reintentos automaticos ante red, 429, timeout o errores del proveedor. No se escala por un fallo tecnico.
- Salida general 2400 tokens; especialista 1600; prueba controlada 512. Extraccion documental conserva su configuracion separada de hasta 12000 por defecto.
- Maximo 32 llamadas por request (configurable hasta 64), con maximo Sol absoluto de uno.
- Contexto textual maximo 200000 bytes; historial en ahorro limitado a 8 mensajes de hasta 5000 caracteres, mas evidencia proyectada existente.
- Cache de respuesta final exacta por usuario, rol, agente y payload; TTL 60s configurable hasta 120s. Solo se habilita despues de consultar datos frescos. No se cachea un primer enrutamiento ni una respuesta con llamadas de herramientas. Un dato distinto invalida la coincidencia.

Los precios son estimaciones configurables, sin descuento por input cacheado, impuestos ni otros servicios.
Referencias oficiales verificadas: [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
Actualizar las tarifas cuando cambie el precio o modelo; no presentar esta estimacion como factura.

## Auditoria y Administracion

La reserva registra antes del envio: timestamp, usuario, request, conversacion, agente, modelo destino, tier, motivo de escalamiento, modelo origen y complejidad estimada.
El cierre agrega tokens input/output/total/reasoning, latencia, tool calls, costo, estado y error normalizado.
`tier=sol` identifica `escalated_to_sol`; `model` es el target model.
No se guardan prompts, resultados comerciales, claves ni errores privados del proveedor en estas tablas.
Acumulados diarios por modelo, agente y conversacion, con llamadas pendientes/desconocidas visibles.
Acceso solo backend service_role y endpoint administrativo existente; anon/authenticated no pueden leer ni modificar directamente el medidor.
Las modificaciones de modo exigen administrador, confirmacion y duracion valida; se registran en la auditoria del Copiloto existente.
No se aplica borrado automatico de este registro de consumo; definir retencion operativa posteriormente sin borrar evidencia de gasto pendiente.

## Configuracion backend

Ver `.env.example`; no copiar secretos a archivos del frontend.

```dotenv
OPENAI_DEFAULT_MODEL=gpt-5.6-luna
OPENAI_ESCALATION_MODEL=gpt-5.6-sol
OPENAI_MODEL_MODE=auto
OPENAI_SOL_AUTO_ESCALATION=true
OPENAI_MAX_SOL_CALLS_PER_REQUEST=1
OPENAI_COST_GUARD_ENABLED=true
DAILY_OPENAI_BUDGET_USD=5
DAILY_OPENAI_SOL_BUDGET_USD=
WARNING_OPENAI_BUDGET_PERCENT=70
ECONOMY_MODE=true
OPENAI_ROUTER_MAX_OUTPUT_TOKENS=2400
OPENAI_SPECIALIST_MAX_OUTPUT_TOKENS=1600
OPENAI_TEST_MAX_OUTPUT_TOKENS=512
OPENAI_MAX_MODEL_CALLS_PER_REQUEST=32
OPENAI_MAX_CONTEXT_BYTES=200000
OPENAI_RESPONSE_CACHE_TTL_SECONDS=60
OPENAI_LUNA_INPUT_USD_PER_MILLION=0.2
OPENAI_LUNA_OUTPUT_USD_PER_MILLION=1.2
OPENAI_SOL_INPUT_USD_PER_MILLION=4
OPENAI_SOL_OUTPUT_USD_PER_MILLION=20
```

Preservar OPENAI_API_KEY exclusivamente en servidor. Las variables antiguas de modelos de texto no deben reactivar Sol; el nuevo router no las usa.
`OPENAI_DOCUMENT_MAX_OUTPUT_TOKENS` sigue aplicando a documentos. OPENAI_LIVE_MODEL y las variables de audio no se cambian.
Un subpresupuesto Sol vacio usa el limite total; configurarlo permite reservar una parte del presupuesto para Luna.

## Pruebas sin costo y prueba controlada

Las suites normales ya usaban mocks; se adaptaron al router, no se presenta ese cambio como ahorro de llamadas reales previamente realizadas.
Se bloquearon dos ejecutores capaces de consumo real en serie: check-copilot-enterprise.mjs (15 casos y 3 seguimientos) y el ejecutor local temporal del Gerente de la fase anterior.
El primero ahora solo consulta herramientas read-only. El temporal se detiene antes de cargar credenciales.

`npm run test:copilot:luna:controlled` solo muestra el plan y termina. No lee stdin ni contacta servicios.
Para ejecutar, un operador backend debe usar `--execute --balance-confirmed` y entregar por stdin la configuracion privada existente (`env`, `rest`, `actor administrador`).
No guarda secretos. Primero comprueba suspension y obtiene un total real con get_sales_summary; luego hace UNA llamada Luna, salida 512, compara el total y muestra tokens/costo/latencia/resultado. No envia correos ni modifica datos comerciales.
El request de validacion tiene identificador diario estable: no permite repetirlo inadvertidamente ese dia despues de haber reservado su llamada.
Se detiene tras ese resultado. Mientras no se confirme saldo, no ejecutar.

`npm run SOL_VALIDATION_TESTS` solo muestra un plan separado. Ademas de las dos banderas, necesita `SOL_VALIDATION_TESTS=true` en el entorno del operador.
Solo tiene un caso, maximo Luna + una revision Sol; no forma parte de ninguna suite normal ni de la prueba inicial solicitada.

Validacion local: 161 pruebas de Copiloto/voz/agentes/costos, suites de Contenido y Comercio Exterior, TypeScript de los tres backends y build frontend. Todos sin llamadas reales a OpenAI.
Vista administrativa verificada en escritorio con fixtures; la comprobacion visual movil quedo inicialmente bloqueada por un dialogo nativo del navegador, reemplazado por confirmacion dentro del panel.

## Publicacion pendiente

1. Obtener autorizacion de publicacion y respaldar versiones actuales/variables sin imprimir secretos.
2. Aplicar exclusivamente openai_cost_guard.sql. No incluir otros SQL contables pendientes del workspace.
3. Configurar las variables nuevas (incluido presupuesto 5) en los backends afectados, manteniendo las credenciales existentes.
4. Publicar exclusivamente `_shared/openai-cost-policy.ts` y crm-copilot; despues frontend.
5. Verificar salud y Administracion sin ejecutar consultas al modelo; mantener quota_blocked hasta confirmar saldo.
6. Con saldo resuelto, una sola prueba controlada Luna y entregar el resultado antes de cualquier otra prueba con costo.

Rollback: preferir desactivar nuevas llamadas y conservar las tablas de auditoria. Volver a codigo anterior reactiva su politica costosa: no hacerlo sin revisar el riesgo de gasto y sin aprobacion.
