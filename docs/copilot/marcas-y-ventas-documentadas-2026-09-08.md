# Marcas y ventas documentadas

- Consultas por nombre, marca Tiendanube y descripcion de producto, sin modificar fichas.
- `result_scope=all_matches` devuelve todas las coincidencias en la tabla, sin truncar a 25. Se conserva el limite de seguridad de respuesta existente: si se excede, se informa el error y no se certifica un listado incompleto.
- Ranking de ventas desde documentos y lineas Facto, no desde snapshots de inventario. Fecha predeterminada: ejercicio actual hasta hoy; periodo configurable.
- Se conservan folio, tipo, fecha, linea, unidades e importe de cada evidencia. Solo ventas emitidas con estado valido; compras y periodos ajenos se excluyen.
- No se leen PDF embebidos. No se escriben movimientos, precios, marcas ni asientos.
- SKU solo cuando la descripcion documental coincide exactamente con un nombre o alias unico del catalogo. Si no, se agrupa por descripcion y moneda, con SKU pendiente.
- Unidades facturadas y neto documental son metricas distintas. Importes se validan contra neto de cabecera, con tolerancia de redondeo. Descuentos no asignables, moneda desconocida o diferencias se muestran como no verificados, nunca cero.
- Notas de credito/debito sin asignacion fiable se reportan como incidencias y el ranking se marca provisional. No se inventan reversas ni se afirma rentabilidad o demanda futura.
- Pruebas: mas de 25 coincidencias, marcas solo en descripcion, filtros, fuentes caidas, duplicacion de documento, direccion, periodo, identidad, moneda e importes inconsistentes.
