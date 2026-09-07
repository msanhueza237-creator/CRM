# Integración de cobranza Facto

## Alcance de la Fase 3

La implementación local agrega una lectura auditable de `Documentos Impagos` sin
reemplazar la integración API existente. No se conecta todavía a Facto real ni se
despliega a producción.

## Flujo

`Finanzas / Fuentes` crea una solicitud de previsualización. Agent Hub entrega una
tarea con arriendo temporal al worker local. El worker consulta primero la API
documentada de Facto y utiliza el navegador únicamente para saldo pendiente,
vencimiento, estado y pagos parciales que la API no expone. El resultado queda en
`integration_sync_items` para revisión humana.

La aplicación aprobada actualiza `reported_balance_clp` y
`reported_paid_amount_clp`. `paid_amount_clp`, las cartolas, conciliaciones y los
asientos permanecen intactos. Así, un saldo informado por Facto nunca se convierte
por sí solo en dinero recibido o en contabilidad contabilizada.

## Orden local de migraciones

1. `supabase/accounting_center.sql`
2. `supabase/agent_hub.sql`
3. Migraciones contables vigentes del repositorio
4. `supabase/facto_receivables_browser_sync.sql`

La última migración es aditiva. Amplía las ejecuciones del Agent Hub, crea sus
ítems de previsualización y agrega dos funciones internas: una para preparar la
comparación y otra para aplicar una previsualización aprobada de forma atómica.

## Credenciales

Las credenciales de API, acceso web y Agent Hub pertenecen al entorno privado del
worker. No se almacenan en tablas, frontend, prompts, capturas ni repositorio. El
archivo `.env.example` contiene solamente nombres de variables y valores ficticios.

## Criterio de aplicación

Una previsualización solo puede aplicarse cuando:

- la lectura de todas las páginas quedó certificada;
- cada saldo abierto tiene evidencia de API y navegador;
- cada cierre tiene evidencia explícita de ausencia en una cartera completa;
- no existen coincidencias ambiguas ni registros inválidos;
- un usuario con permiso de importación confirma la operación en el CRM.

## Estado de la Fase 4

La validación controlada del conector API se ejecutó el 7 de septiembre de 2026.
Confirmó la estructura HAL, dirección de documentos emitidos, monedas, paginación,
fecha final local y reintentos temporales. La prueba con datos demostrativos del
sandbox oficial completó 23 documentos emitidos sin realizar escrituras.

La previsualización real de Latin Chile quedó bloqueada de forma segura: el host
legado configurado para la empresa respondió `502` después de todos los reintentos
y las mismas credenciales no fueron aceptadas por el host oficial vigente. La
validación web complementaria también queda pendiente hasta disponer de una sesión
automatizable o credenciales privadas administradas por el worker. Ninguna de estas
condiciones se interpreta como una cartera vacía y no se modifica el CRM.

El detalle de evidencia, alcance y pendientes está en
`docs/facto-phase4-validation-2026-09-07.md`.

### Diagnóstico aislado

`npm run facto:receivables:phase4 -- --from AAAA-MM-DD --to AAAA-MM-DD`
consulta únicamente la API y deja un informe local sin respuestas crudas ni
secretos. `--with-browser` agrega la lectura de `Documentos Impagos` cuando la
ruta y las credenciales web privadas hayan sido verificadas. El comando no se
conecta a Supabase: la clasificación definitiva entre crear, actualizar,
duplicado o coincidencia dudosa se calcula posteriormente en el staging del CRM.

Los errores temporales `429`, `502`, `503` y `504` respetan `Retry-After` y usan
reintentos acotados. Agotado el límite, la ejecución queda bloqueada con cero
escrituras y un informe de evidencia local.

La lectura admite tanto la respuesta histórica `documents` como la representación
HAL vigente `_embedded.documents`. Esto mantiene compatibilidad con el host legado
sin confundir una colección anidada con una cartera vacía.

Para cuentas por cobrar se usa `received_issued_flag=1`, que Facto define como
documento emitido. El valor `0` corresponde a documentos recibidos y no debe usarse
para esta cartera. El mapa base de monedas sigue la tabla oficial: `39=CLP`,
`5=USD` y `38=EUR`. Facturas de exportación (`110`) son cobrables; notas de
crédito, notas de débito, guías y documentos internos permanecen en revisión.

El host oficial vigente es `https://apifacto.com/v1`. Una cuenta que todavía use
credenciales del host legado debe configurar `FACTO_API_BASE_URL` explícitamente;
el conector no cambia credenciales ni intenta migrarlas entre hosts. Como la
documentación pública solo garantiza `issue_date_from`, la fecha final también se
valida localmente después de completar todas las páginas.

Las boletas anónimas que no aparecen en una lectura completa de `Documentos
Impagos` se excluyen de la cartera por cobrar. Si una boleta sin cliente aparece
como deuda abierta, permanece bloqueada para revisión en vez de inventar una
contraparte.
