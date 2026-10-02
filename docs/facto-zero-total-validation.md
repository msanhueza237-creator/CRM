# Validación de total cero con evidencia no facturable

Corrección local, sin commit ni despliegue. Base revisada: `767f663`; se conservaron los cambios ajenos del árbol de trabajo.

## Comportamiento

- Total ausente: `total_missing`.
- Total malformado: `total_invalid`; no se confunde una conversión numérica fallida con cero.
- Alias de total contradictorios: `totals_conflicting`.
- Cero explícito sin respaldo suficiente: `zero_total_evidence_required`.
- Cero respaldado por el perfil DTE comprobado: `non_billable_accounting_review_required`, con evidencia separada de `MontoNF` y `MontoPeriodo`.

El último caso sigue bloqueado para importación/contabilización automática: identificar correctamente un total cero no decide si la operación es gasto, compra, costo, IVA, pago o movimiento bancario. No se suma MontoNF al total ni se sustituyen importes. No se cambia el ranking, los estados productivos ni el flujo de contabilización.

No hay excepción por banco, nombre o RUT. La evidencia exige dirección de compra, DTE34, CLP explícito, importes facturables cero, identidad/folio/fecha coincidentes con el XML, un único encabezado y totales coherentes, MontoNF positivo igual a MontoPeriodo y suma exacta de detalles no facturables (IndExe=2). Se rechazan duplicados, impuestos o saldos no modelados y estructuras no soportadas.

El lector XML es deliberadamente limitado, con límites de tamaño/profundidad y sin resolución de entidades ni accesos externos. No valida firmas ni autenticidad ante SII. XML con DTD, comentarios, CDATA o elementos con prefijo queda pendiente, aunque pueda ser XML válido. Se admite el perfil de los ocho respaldos inspeccionados, en texto o base64; ampliar perfiles requiere pruebas y revisión explícita.

## Evidencia y fixtures

`scripts/fixtures/facto-zero-total-cases.json` conserva los patrones monetarios, fechas y número de líneas de los ocho casos cero y cuatro combustibles. Folios, emisor y receptor son sintéticos en las pruebas; no incluye RUT reales, nombres, direcciones, firmas, certificados, XML completos ni credenciales. No usar los fixtures como documentos contables.

Contraste adicional offline contra 631 documentos de la lectura autorizada guardada: idénticos importes y demás campos normalizados; solo cambió el diagnóstico de los ocho casos cero. Los ocho XML originales pasan la comprobación de evidencia. Las cuatro facturas de combustible conservan `totals_mismatch`; no se corrigen ni se aprueban.

## Validación

Pruebas específicas: `node --experimental-transform-types --test scripts/test-facto-zero-total.mjs` (43 casos).

Suite de regresión: pruebas de total cero, política documental, espejo, costo, devolución, notas de crédito, rentabilidad, cobertura y seguridad de sincronización (137 pruebas en conjunto). Además: `npm run test:accounting` con base local PGlite, tipos estrictos de los módulos modificados y `npm run build`.

Lint focalizado: `node node_modules/eslint/bin/eslint.js supabase/functions/accounting-center/facto-document-normalization.ts supabase/functions/accounting-center/facto-non-billable-evidence.ts scripts/test-facto-zero-total.mjs`.

El lint global `npm run lint` detectó 116 errores y 109 advertencias en archivos ajenos a esta corrección, incluyendo artefactos preexistentes de `tmp`, declaraciones de runtime y módulos existentes. No se corrigieron ni silenciaron problemas ajenos. La compilación avisa de chunks grandes.

No se ejecutaron sincronizaciones ni consultas/mutaciones productivas durante esta implementación. No se instalaron dependencias. La prueba de concurrencia SQL requiere un clúster local desechable y argumentos explícitos; no se ejecutó ese escenario, pues no se modificó concurrencia ni SQL.
