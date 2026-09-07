# Acta de validación Facto - Fase 4

Fecha: 7 de septiembre de 2026

## Objetivo

Validar el conector de cuentas por cobrar con una prueba controlada y de solo
lectura antes de permitir cualquier sincronización con el CRM.

## Garantías de la prueba

- No se escribieron datos en Facto.
- No se escribieron datos en Supabase ni en el CRM.
- No se crearon pagos, movimientos bancarios, conciliaciones ni asientos.
- Los informes locales no contienen tokens, contraseñas ni respuestas crudas.
- Un error o una lectura incompleta bloquea el proceso; nunca se interpreta como
  una cartera vacía.

## Resultado técnico

La prueba contra el sandbox oficial de Facto fue satisfactoria:

- autenticación correcta;
- 23 documentos emitidos encontrados desde el 7 de septiembre de 2026;
- una página leída por completo;
- 7 facturas y 14 boletas identificadas como documentos de venta;
- 2 documentos no cobrables separados para revisión;
- cero escrituras en todos los sistemas.

Estos registros son datos demostrativos del sandbox y no pertenecen a Latin
Chile. Solo prueban el funcionamiento del lector y del clasificador.

## Correcciones incorporadas

- Se usa `received_issued_flag=1` para documentos emitidos. El valor `0`
  corresponde a documentos recibidos.
- Se reconoce la colección HAL `_embedded.documents` del endpoint oficial.
- Se mantienen los códigos oficiales de moneda: `39=CLP`, `5=USD` y `38=EUR`.
- Se filtra localmente la fecha final después de leer todas las páginas.
- Se reintentan de forma acotada los errores temporales `429`, `502`, `503` y
  `504`, respetando `Retry-After`.
- Se reconocen facturas de exportación y se dejan notas, guías y documentos no
  cobrables en revisión.
- Una boleta anónima que no integra la cartera completa se excluye; si aparece
  impaga, se bloquea para revisión sin inventar una contraparte.

## Bloqueo de la cuenta real

El endpoint legado configurado para Latin Chile respondió `502 Bad Gateway` en
intentos separados. El endpoint oficial actual respondió `400` al probar las
credenciales legadas. El conector no migró, reemplazó ni expuso esas credenciales.

Por seguridad, todavía no se puede informar cuántos documentos reales serían
nuevos, actualizados, duplicados o dudosos. El resultado correcto en este estado
es `FACTO_TEMPORARILY_UNAVAILABLE`, con cero escrituras.

La comprobación web de `Documentos Impagos` también queda pendiente: la sesión
abierta manualmente no pudo ser controlada por el worker y no existen credenciales
web privadas configuradas para iniciar una sesión efímera.

## Evidencia local

- Sandbox oficial validado:
  `.facto-evidence/facto-phase4-dry-run-2026-09-07T16-26-11-366Z.json`.
- Cuenta real bloqueada después de los reintentos:
  `.facto-evidence/facto-phase4-dry-run-2026-09-07T16-37-56-381Z.json`.

Ambos informes registran explícitamente cero escrituras en Facto, CRM, bancos,
conciliaciones y contabilidad.

## Criterio para continuar

Antes de habilitar una escritura limitada se requiere una de estas condiciones:

1. Que Facto restablezca el endpoint legado usado por Latin Chile.
2. Que Facto entregue credenciales válidas para `https://apifacto.com/v1`.

Después se repetirá el dry run real y se revisarán sus grupos: encontrados,
nuevos, actualizables, duplicados y casos dudosos. La aplicación al CRM seguirá
requiriendo aprobación independiente y no generará pagos ni asientos contables.
