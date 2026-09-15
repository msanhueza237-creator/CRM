# Prestamos recibidos

Ruta: `/finanzas-contabilidad?view=loans`. Solo administracion y finanzas.

## Registro

- El borrador identifica prestamista, RUT opcional, capital CLP, cuenta de pasivo, fecha de recepcion, vencimiento, destino y condiciones.
- Los intereses no informados permanecen por definir. El capital no es ingreso ni aporte patrimonial.
- El ingreso se vincula con un abono real de cartola del mismo monto y fecha. Se revisa el asiento antes de confirmarlo.
- Si el banco ya fue contabilizado contra una transitoria, se reclasifica esa transitoria. No se duplica banco.
- Las devoluciones se vinculan con egresos de cartola y no pueden exceder el capital pendiente. Cada movimiento completo corresponde a capital, sin intereses mezclados.
- La fecha de devolucion es un vencimiento, no una transferencia programada. El destino/invoice es una referencia informativa; no confirma ni repite el pago al proveedor.
- Los prestamos anteriores sin movimientos vinculados no se incluyen en los totales de esta pantalla. No se migra ni modifica su saldo automaticamente.
- Un asiento reversado bloquea nuevos movimientos hasta revision contable. No se borra ni reescribe la historia.

## Componentes

`supabase/accounting_loans.sql`: migracion aditiva y funciones transaccionales. Aplicar con respaldo previo, sin ejecutar otras migraciones financieras pendientes.

`accounting-center`: rutas `loans`, `loans/save`, `loans/preview`, `loans/post`. El actor procede de la sesion autenticada; el cliente no determina permisos ni puede convertir una vista previa en confirmacion.

La contabilizacion enlaza prestamo, movimiento bancario, conciliacion, asiento y auditoria en una sola transaccion. La clave `bank-reconciliation:<id>` mantiene compatibilidad con la cobertura del libro bancario y evita volver a centralizar el mismo abono.

## Verificacion

```sh
node --experimental-strip-types scripts/test-accounting-loans.mjs
node scripts/test-accounting-loans-api.mjs
node scripts/test-accounting-loans-ui.mjs
npm run build
```

Las pruebas de interfaz usan peticiones simuladas, nunca datos de produccion. Se prueban borrador, vista previa sin escritura, reintentos, registro y devolucion, errores, filtros y resoluciones 1440/390/320.
