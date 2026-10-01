# Analisis de empresas

La ficha `/empresas/:id` incorpora ventas netas, costo documentado, utilidad
bruta y margen; conserva los estados verificado, provisional, parcial y sin
evidencia del dashboard. No contabiliza ni estima costos nuevos.

`crm-copilot/company-insights` es un GET autenticado sin llamadas a modelos.
Reutiliza el registro de herramientas, permisos, fuentes y cache por solicitud.
Comercial obtiene la ficha y productos; Finanzas obtiene la rentabilidad.
La voz y chat siguen utilizando el Gerente y los mismos especialistas.

- `get_customer_profile`: campos comerciales permitidos, contactos, etiquetas,
  ultimas 20 tareas e interacciones, y fechas/conteo historico de facturas.
- `get_customer_products`: exige ID de empresa y RUT unico. Cruza receptor y
  emisor, trae solo detalles de documentos del cliente y periodo, y reutiliza
  `productSales`. Separa monedas y unidades/importe; pagina diez productos.
- `get_customer_profitability`: acepta `company_id`; accounting-center filtra
  por RUT exacto y entidad activa antes de usar el calculo comun. No utiliza
  coincidencias parciales de nombres para atribuir cifras a una ficha.
  Exige confirmacion de ID/RUT en la respuesta, tambien durante despliegues
  mixtos: una version antigua nunca sustituye el cliente por el ranking general.

Los productos muestran unidades facturadas, no consumo fisico. Las notas no
asignadas a productos quedan pendientes; no se inventan devoluciones. El costo
actual del catalogo no se usa como costo historico ni se aplica el margen global
del cliente a sus productos. Los conceptos sin SKU conservan esa advertencia.

## Clasificacion

Administracion dispone de `customer-classification` GET/POST, con preview,
huella de evidencia y confirmacion. Solo facturas de venta validadas/vigentes
de la entidad activa acreditan cliente; no guias, notas, compras ni deuda.
Los clientes sin compras recientes no se degradan a prospectos.

Cambiar estado conserva categoria, contactos, consentimiento e historial.
Cada cambio de ficha existente usa control de version y estado previo.
Antes de cada escritura se descarta la cache de la solicitud y se vuelve a
leer identidad y evidencia. Cambios concurrentes observados quedan pendientes.
Crear fichas requiere confirmacion adicional `includeNew`, razon social,
RUT con digito verificador valido y ausencia de conflicto de identidad/nombre.
El ID determinista y la insercion sin sobrescritura evitan duplicados al
reintentar. No se inventan contactos ni se concede consentimiento de envio.
Sin un indice unico normalizado, una creacion manual simultanea con otro ID
no se puede excluir atomicamente. El lote se aplica sin ediciones simultaneas
y se verifica nuevamente al terminar; este cambio no modifica el esquema.
Identidades ambiguas se informan para revision, sin fusion ni borrado.

El ingreso existente de documentos en crm-agent vuelve a clasificar fichas
existentes solo cuando su clave ya tiene `crm:write`. No amplia permisos.
No crea fichas nuevas automaticamente: quedan en el preview administrativo.
Un fallo de clasificacion no interrumpe la recepcion de documentos.

Se conservan eventos de auditoria y el resultado idempotente del ingreso.
No hay migraciones, variables nuevas, cambios RLS ni escrituras contables.

## Pruebas

`npm run test:companies` ejecuta `scripts/test-company-insights.mjs` y cubre identidades, documentos excluidos,
periodos, monedas, permisos, conflictos, idempotencia, emisor/receptor y UI.
Ejecutar tambien las suites de Copiloto, agentes, rentabilidad y dashboard,
`npm run typecheck:copilot` y `npm run build`.

La validacion visual usa el componente real con datos sinteticos marcados como
prueba, no como evidencia de produccion. Tras publicar, verificar una ficha real
y una consulta del Gerente; reclasificar solo el lote autorizado y comprobar
las fichas persistidas. El frontend no despliega las Edge Functions.

Validacion local del 30-09-2026: 175 pruebas de empresas, rentabilidad, agentes,
Copiloto y dashboard aprobadas; typecheck y build aprobados. Vista del componente
real comprobada a 390x844 y 1366x900, incluyendo estados de carga, error y vacio.
No se modifico produccion ni se crearon clientes durante estas pruebas.

La publicacion debe incluir las dependencias compartidas nuevas, `crm-agent`,
`accounting-center` y `crm-copilot`, ademas del frontend. Verificar el perfil
exacto por ID y RUT y conservar las advertencias de costos/notas pendientes.
