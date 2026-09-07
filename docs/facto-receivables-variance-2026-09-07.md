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

## Corrección local

- Una foto solo puede reemplazar el total de cobranza si declara cobertura completa.
- La cantidad de documentos debe coincidir con el detalle.
- Cada documento debe tener una identidad única y un saldo verificable.
- La suma del detalle debe cuadrar con el total informado, con tolerancia de CLP 0,50.
- Una lectura parcial puede actualizar sus saldos individualizados, pero nunca cerrar
  documentos ausentes ni reemplazar el total del tablero.
- El corte manual de julio de 2026 fue retirado como sustituto del dato vigente.

## Estado

La corrección está validada localmente. No se aplicó ninguna modificación a producción.
La reconstrucción exige una lectura web completa o el Excel vigente exportado desde
`Documentos impagos`; el archivo recibido a continuación aporta ese detalle sin distribuir
manualmente el total entre facturas.

## Evidencia recibida

- Archivo: `documento (8).xlsx`.
- SHA-256: `B157E44C0B685A9A8574FC831728F4F461E5A33C64EA6976AD6E6D87219747A0`.
- Filas válidas: 27; errores: 0.
- Cuentas por cobrar: 17 documentos, total pendiente `$11.287.934`.
- Documentos por pagar: 8 obligaciones, total pendiente `$12.867.255,19`.
- Ajustes documentales: 2 notas de crédito, excluidas de saldos positivos.

La suma de las facturas emitidas coincide con el control Facto: neto `$28.164.014`, IVA
`$5.351.170`, total `$33.515.184`, pagado `$22.227.250` e impago `$11.287.934`.
