# Documentos financieros: verificacion del 10-09-2026

## Alcance

- Facto sigue en modo lectura. No se modificaron documentos del proveedor.
- El conector incorpora notas de credito/debito, compras exentas y facturas extranjeras tipo 57.
- Los detalles conservan referencias, direccion recibida/emitida, fechas y totales originales.
- Compras documentales se grafican aparte del costo de ventas: no se restan otra vez del resultado.
- Las recepciones de inventario y proformas no son facturas adicionales de compra.
- La factura extranjera recuperada por API se vincula a su fuente Excel existente cuando coinciden identidad, fecha, proveedor y total. El monto de factura no demuestra saldo impago.

## Comprobaciones reales

- Junio: tres facturas extranjeras por CLP 56.620.788 netos y compras nacionales por CLP 5.533.462; total CLP 62.154.250. La factura extranjera 3 conserva su identificador de fuente Excel, sin duplicarse.
- Factura 1534 (28-07): neto CLP 9.091.838. Nota de credito 80 (18-08): mismo neto, referencia explicita a 1534. Factura 1547 (18-08): neto CLP 8.506.330. No se cambia ninguna fecha de emision.
- Costo 1547 verificado en Contabilidad de Facto: debe 5101 / haber 1201, CLP 6.000.000. Registrado con clave idempotente y evidencia.
- Quince notas de credito emitidas de 2026 contabilizadas, total neto CLP 13.177.574. Tres notas de proveedor, CLP 69.989 netos, permanecen exclusivamente en compras.
- Las tres copias erroneas de notas recibidas que estaban como ventas se conservaron anuladas con reversos compensatorios y auditoria, sin borrar el historial.
- Enero estaba cerrado. Sus notas 70, 71 y 72 se regularizaron el 10-09 en periodo abierto (CLP 1.938.305 netos), manteniendo emision y referencias originales. El dashboard identifica ambas fechas y atribuye la deduccion al mes contabilizado.
- Facturas 1554 a 1557: CLP 638.776 netos, centralizadas por identificadores especificos, sin ejecutar ajustes bancarios generales.
- Siete documentos ADS ya tenian asientos: se conservaron. Cuatro son exentos (1214, 1215, 1702, 1798). Los filtros y la indicacion de contabilizacion ahora incluyen ese historial.
- Estado de resultados: ingresos totales CLP 124.025.494 (incluye CLP 2 de otros ingresos), costo CLP 85.339.554, gastos CLP 18.036.645, resultado provisional CLP 20.649.295. El balance de ocho columnas entrega el mismo resultado, con diferencias de cuadratura cero.
- No hay asientos publicados descuadrados. Enero sigue cerrado.

## Limites pendientes

- La primera relectura masiva tuvo respuestas 429 y fue parcial. La relectura prioritaria de 30 documentos termino sin errores. No equivale a certificar que cada detalle historico haya sido releido.
- Hay 47 facturas sin costo exacto verificado y 12 compras con importes o validacion pendientes. No se inventaron costos ni reversos de costo a partir del precio de una nota de credito; el resultado sigue provisional.
- Los saldos de bancos, conciliaciones y cheques no se ajustaron para hacer coincidir este grafico.
- Las compras internacionales no se volvieron a centralizar sobre la recepcion de inventario existente.

## Seguridad y pruebas

- Respaldo privado previo de tablas contables, evidencia de integracion, funciones e imagen del conector en el VPS. Sin respaldo ni credenciales en Git.
- Centralizacion limitada a documentos Facto validados, permiso de contabilizacion, fechas verificadas y claves idempotentes. Sin migracion SQL.
- Pruebas de ventas/compras, direccion documental, exentas, duplicados, regularizaciones y periodos cerrados.
- Pruebas contables de doble partida, inmutabilidad, reversos y cierre.
- Pruebas de interfaz con Playwright entre 320 y 1440 px y roles administrador, finanzas y vendedor. Datos sinteticos para interaccion; verificacion de produccion en lectura.
