# Ventas documentadas en el dashboard

## Causa y alcance

El respaldo documental se aplicaba solo si las ventas contables de todo el anio
eran cero. Un mes nuevo o una factura nueva quedaban omitidos cuando ya existian
asientos historicos. Ahora se complementan los ingresos por identidad de documento:

- Solo documentos de venta validados, emitidos hasta el corte de Santiago.
- Un asiento de ingreso contabilizado o reversado evita volver a sumar su fuente.
- Un asiento de costo, pago o borrador no equivale al ingreso de la factura.
- Las notas de credito restan; el IVA no se suma a las ventas netas.
- La moneda extranjera exige tipo de cambio conocido.
- Se distinguen ventas contabilizadas y documentos sin asiento, con folio y fecha.
- No se crean asientos, pagos, conciliaciones ni actualizaciones de facturas.

El estado de resultados sigue siendo contable. El dashboard puede mostrar una
base mixta provisional diferente mientras existan documentos pendientes; los
enlaces separan la fuente documental del informe contable. No se certifica margen
cuando falta costo, ni se modifica la fecha que entrega Facto.

## Verificacion de solo lectura (9 septiembre 2026)

La API real de Facto devolvio una pagina completa con un documento entre el 1 y
el 9 de septiembre: factura 1557, emision 2026-09-08, neto CLP 149421, total con
IVA CLP 177811. El CRM contiene el mismo documento y fecha, sin asiento de ingreso.
No se corroboraron otras ventas emitidas el dia 9; se solicitaron sus folios.

Tambien se identificaron sin asiento las facturas 1554, 1555 y 1556, todas emitidas
el 31 de agosto. La lectura no modifico produccion.

## Pruebas

- `node --experimental-strip-types --test scripts/test-dashboard-sales.mjs scripts/test-dashboard.mjs`
- `node scripts/test-dashboard-ui.mjs` con `DASHBOARD_UI_URL` del Vite local.
- `npm run test:accounting`
- `npm run build`

Desplegar conjuntamente `accounting-center/index.ts`, `dashboard-sales.ts` y la
interfaz. No requiere SQL. Esta documentacion no constituye autorizacion de despliegue.
