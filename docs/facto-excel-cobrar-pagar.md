# Excel Facto: por cobrar y por pagar

El mismo respaldo de documentos impagos se carga desde Finanzas > Fuentes,
Por cobrar o Por pagar. Antes de confirmar, la vista separa documentos emitidos,
documentos recibidos, abonos y saldos en CLP. Las notas de credito se conservan
como evidencia, sin convertirlas en deudas positivas.

## Alcance

- Requiere confirmar el periodo y un reporte sin filtros de cliente, proveedor
  o tipo de documento. El servidor valida esa confirmacion.
- Lee las hojas con encabezados Facto. Si una hoja contiene documentos sin un
  encabezado reconocible, rechaza la carga para no omitir obligaciones.
- Exige folio, tipo y contraparte compatibles. El RUT distingue proveedores que
  tienen facturas con el mismo numero. Las coincidencias ambiguas se rechazan.
- Conserva pagos y saldos bancarios conciliados; actualiza solamente los campos
  informados por Facto. No crea asientos ni movimientos de banco.
- El cierre de documentos ausentes solo opera en el periodo cubierto, sobre
  documentos Facto y para las secciones presentes. Un archivo solo de clientes
  no cierra cuentas de proveedores, ni a la inversa.
- Valida el detalle contra los totales de ambas carteras antes de cerrar ausentes.
- Permite reintentar una confirmacion interrumpida sin perder las filas ya
  procesadas. La identidad de un documento nuevo no depende de sus abonos.
- Por pagar muestra el ultimo respaldo, fecha de corte, actualizacion de cada
  factura y descarga del original. Sus filtros usan el saldo operativo y la
  carga no queda limitada a los primeros 500 proveedores.

## Publicacion

Ademas de la interfaz, requiere publicar `accounting-center/index.ts` y
`accounting-center/facto-excel-parsers.ts`. El normalizador bancario compartido
ya forma parte de la funcion.

Aplicar la definicion de `supabase/accounting_facto_outstanding_snapshot.sql`
antes de habilitar el nuevo importador. Solo reemplaza la funcion de cierre;
el script no actualiza saldos por si mismo. No ejecutar otros SQL contables.

No reimportar respaldos historicos automaticamente. La siguiente carga debe
ser el Excel actualizado que el usuario revise y confirme.

## Verificacion

```powershell
node --experimental-strip-types scripts/test-facto-excel-payables.mjs
npm run test:accounting
node scripts/test-facto-excel-ui.mjs
npm run build
```

Con Vite en el puerto 5183:

```powershell
node scripts/test-facto-payables-browser.mjs
```

El test de importacion acepta como argumento opcional un Excel local para
verificar el parser real en solo lectura. Los tests de navegador usan fixtures,
sin sesiones ni escrituras en produccion.
