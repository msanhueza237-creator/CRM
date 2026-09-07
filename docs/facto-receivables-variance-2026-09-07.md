# Variación de cobranza Facto - 2026-09-07

## Control informado

- Fuente: Facto web, `Cobranza > Documentos impagos`.
- Período consultado: 2026-01-01 al 2026-09-07.
- Documentos: 17.
- Saldo pendiente informado: CLP 11.287.934.

## Hallazgo en el CRM

La foto financiera más reciente contenía solamente cuatro saldos individualizados por
CLP 474.401. Su cobertura estaba marcada como parcial (`portfolio_complete: false`),
pero una regla anterior interpretó la disponibilidad de 418 PDF como prueba de una
cartera completa.

Como consecuencia, 155 documentos no incluidos en esos cuatro saldos fueron marcados
con saldo reportado cero. La auditoría conservó el evento y permitió identificar el
alcance exacto; no se modificaron pagos bancarios ni conciliaciones.

## Corrección aplicada

- Una foto solo puede reemplazar el total de cobranza si declara cobertura completa.
- La cantidad de documentos debe coincidir con el detalle.
- Cada documento debe tener una identidad única y un saldo verificable.
- La suma del detalle debe cuadrar con el total informado, con tolerancia de CLP 0,50.
- Una lectura parcial puede actualizar sus saldos individualizados, pero nunca cerrar
  documentos ausentes ni reemplazar el total del tablero.
- El corte manual de julio de 2026 fue retirado como sustituto del dato vigente.

## Estado

La corrección fue desplegada en producción el 2026-09-07. El archivo vigente exportado
desde `Documentos impagos` quedó almacenado como evidencia del lote
`c780c6f8-b15e-4798-b13a-bdbea1565530` y se aplicó como cartera completa para el período
2026-01-01 al 2026-09-07.

Durante la comprobación posterior se detectó que la sincronización histórica aceptaba la
foto Excel como completa, pero todavía omitía sus detalles por no reconocer el origen
`facto_excel`. El commit `e39b5cc` centralizó los orígenes verificados y agregó una prueba
de regresión. Después de repetir el ciclo completo, la sincronización actualizó 17 saldos,
omitió 0 y conservó el total de CLP 11.287.934.

## Evidencia recibida

- Archivo: `documento (8).xlsx`.
- SHA-256: `B157E44C0B685A9A8574FC831728F4F461E5A33C64EA6976AD6E6D87219747A0`.
- Filas válidas: 27; errores: 0.
- Cuentas por cobrar: 17 documentos, total pendiente `$11.287.934`.
- Documentos por pagar: 8 obligaciones, total pendiente `$12.867.255,19`.
- Ajustes documentales: 2 notas de crédito, excluidas de saldos positivos.

La suma de las facturas emitidas coincide con el control Facto: neto `$28.164.014`, IVA
`$5.351.170`, total `$33.515.184`, pagado `$22.227.250` e impago `$11.287.934`.

## Control final de producción

- Dashboard: 17 cuentas por cobrar, total `$11.287.934`.
- Cuentas por pagar: 8 obligaciones, total `$12.867.255,19`.
- Notas de crédito con saldo positivo: 0.
- Movimientos bancarios: 1.097 antes y después.
- Conciliaciones: 189 antes y después.
- Vínculos de conciliación: 190 antes y después.
- Asientos contables: 1.747 antes y después.
- Líneas contables: 3.799 antes y después.
