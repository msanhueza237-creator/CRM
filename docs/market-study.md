# Estudio de Mercado — primera versión local

Estado: integrado en `/estudio-mercado`, navegación y Top 10 del Dashboard. Acceso limitado al perfil existente `administrador` activo, igual que Comercio Exterior. No está desplegado. Se recuperaron los archivos locales previos del módulo y se completaron sus controles, documentación y verificaciones; los cambios ajenos se conservaron.

## Uso

1. Abrir Investigaciones, pegar o seleccionar un JSON v1, revisar la vista previa y confirmar la carga.
2. Revisar cada equivalencia: producto interno, modelo/capacidad/marca, unidad base, cantidad por unidad interna y base del costo. El SKU sugerido no aprueba una coincidencia. Confirmar o rechazar con motivo.
3. Abrir Simulador para cantidad, descuento porcentual o precio objetivo neto CLP, y margen mínimo elegido. No guarda precios ni promociones. Puede simular sin oferta de mercado; marca costo/base provisional e información insuficiente.
4. Consultar Oportunidades o Dashboard, filtrar actual/tránsito y entrar al detalle. No se completan diez posiciones artificialmente.

## Arquitectura y archivos

- `src/modules/market-study/`: página, tabla compartida, widget Dashboard, adaptadores de fuentes, matemáticas y CSS adaptable.
- `src/lib/marketStudyApi.ts`: transporte con sesión Supabase existente y sin caché.
- `supabase/functions/_shared/market-study-contract.ts`: contrato y validación compartidos por UI/API.
- `supabase/functions/market-study/`: Edge Function y handler comprobable con fetch inyectado.
- `supabase/market_study.sql`: propuesta SQL local, tablas append-only y RPC transaccionales. No ejecutada fuera de PGlite sintético.
- Integraciones locales existentes preservadas en `src/App.tsx`, `src/modules/layout/AppLayout.tsx`, `src/modules/dashboard/DashboardPage.tsx` y referencia de tipos en `tsconfig.app.json`.

El handler reutiliza los lectores del CRM, resolución de catálogo y valorización de Facto; no abre Facto ni sincroniza datos. Consulta Comercio Exterior con el JWT del usuario y recalcula mediante su motor de costos. Solo escribe investigaciones/revisiones propias mediante RPC; no tiene rutas de precios ni contabilidad. No se modificó voz.

## Reglas financieras

Precio neto = bruto / (1 + IVA/100); exento requiere IVA 0 explícito. Moneda desconocida o IVA desconocido no se convierten. CLP no necesita cambio; otras monedas requieren CLP por unidad, moneda coincidente, fuente y fecha no futura de hasta 7 días.

Utilidad bruta unitaria = venta neta − costo; total = utilidad unitaria × cantidad; margen = utilidad / venta × 100. Venta cero no tiene margen definido. Markup se muestra separado y usa costo como denominador. Costo ausente permanece null; costo cero solo se acepta si está expresamente registrado. No se calcula utilidad neta.

Precio con descuento = precio × (1 − descuento/100); el objetivo neto reemplaza ese cálculo. Precio mínimo teórico = costo / (1 − margen elegido/100). Descuento máximo solo se muestra si ese precio es positivo y no supera el precio actual; costo cero no produce un descuento del 100% con margen ficticio. Son límites matemáticos del escenario, no una autorización comercial. Redondeo de cálculo a 6 decimales; presentación monetaria hasta 2.

Top 10: mínimo(margen %, ventaja % frente a mediana) × menor confianza. Desempate por margen y clave. Una oferta por oferente (nombre normalizado), última versión por identidad externa; no se reutiliza aprobación de una revisión anterior. Requiere equivalencia coherente, confianza ≥70%, ofertas competidoras disponibles ≤30 días, costo/precio ≤30 días y stock positivo ≤2 días. El tránsito exige ETA válida no vencida y supuestos completos. Mostrar oferta no significa certificar disponibilidad libre de reservas, demanda ni venta.

## Tránsito y limitaciones explícitas

Separa `current:SKU` de `transit:operacion:linea`; no suma recepciones futuras al stock disponible. Solo operaciones future no recibidas/cerradas/canceladas y escenario baseline único. Usa costo puesto en Chile del motor existente con IVA recuperable separado. No sobrescribe costos históricos. Precio propio solo se vincula por SKU inequívoco.

Escenarios sin fecha de origen del cambio (`assumptions.fx_observed_at`) pueden simularse como estimación, pero quedan fuera del ranking; la pantalla actual de Comercio Exterior no captura necesariamente ese dato. Hará falta completar esa evidencia en una futura ampliación autorizada. No se usa la fecha de guardado como fecha del tipo de cambio. Un mismo cambio de revisión interna admite una moneda extranjera; si costo y precio usan dos monedas extranjeras diferentes, la conversión incompleta se bloquea.

Si Facto devuelve varias listas sin selección inequívoca, los precios quedan ausentes. No se elige una lista arbitrariamente en esta versión. Límites de lectura: 5.000 versiones, 10.000 revisiones, 50 operaciones de tránsito y límites del lector de inventario existente. Al superarlos o fallar una fuente se informa cobertura no verificada; no se presenta una lista truncada como completa. Historial sin paginación en esta versión. Deduplicación de oferentes por nombre no resuelve automáticamente alias de empresas.

## Conexión futura del dot: API HTTP v1

El dot todavía no existe ni está conectado. Se entrega un adaptador HTTP, no un servidor MCP nuevo. Base futura: `/functions/v1/market-study`. Todas las rutas de datos y health requieren `Authorization: Bearer <JWT de sesión existente>` y un administrador activo comprobado en profiles, nunca user_metadata. OPTIONS solo negocia CORS para el origen configurado. No entregar service_role al dot ni extraer tokens de sesiones del navegador.

| Método / ruta | Entrada / salida |
|---|---|
| GET health | servicio y versión, con autenticación |
| GET bootstrap | investigaciones, revisiones, inventario/costos, operaciones, cobertura y fecha de lectura |
| POST imports/preview | JSON v1 → items normalizados, errors con fila, total, canImport; sin escribir |
| POST imports/commit | mismo JSON v1 → inserted, duplicates; lote atómico, todo vuelve a validarse |
| POST reviews | revisión humana con request_id UUID y expected_review_id; historial y control de concurrencia |

Lotes de 1–200 observaciones y hasta 350 KB. Precio null significa ausente, nunca cero. Rechaza coerciones numéricas, claves de aprobación/permisos dentro de observaciones, URL con credenciales o esquemas ejecutables, fechas inválidas/futuras y cantidades inválidas. Texto investigado solo se renderiza como texto: nunca instrucciones, HTML, herramientas ni navegación automática.

Identidad idempotente: `(provider, external_id, revision)`. Primera revisión 1, siguientes consecutivas. Misma clave y payload normalizado devuelve duplicate; misma clave con cambio devuelve 409 y revierte el lote. Revisiones humanas usan request_id; el mismo request reintentado devuelve el original. Cambio concurrente de revisión exige recargar. Ante timeout de commit, reintentar el mismo lote, no incrementar revision por el timeout.

Ejemplo sintético (la fecha debe reemplazarse por la de investigación real antes de usarlo):

```json
{
  "schema_version": 1,
  "observations": [{
    "provider": "dot-marco",
    "external_id": "offer-001",
    "revision": 1,
    "product_label": "Bomba de prueba",
    "suggested_sku": "SYN-01",
    "seller": "Competidor sintético",
    "seller_kind": "competitor",
    "amount": 142800,
    "currency": "CLP",
    "vat_basis": "gross",
    "vat_percent": 19,
    "unit": "unit",
    "package_quantity": 1,
    "presentation": "Una bomba; especificaciones por revisar",
    "availability": "available",
    "source_url": "https://example.test/offer-001",
    "observed_at": "2026-10-01T12:00:00Z",
    "confidence": 0.9,
    "fx": null,
    "notes": "Ejemplo sintético. No es evidencia comercial."
  }]
}
```

Para moneda extranjera: `fx: {currency:"USD", clp_per_unit:900, observed_at:"2026-10-01T12:00:00Z", source:"Referencia sintética"}`. Unidades aceptadas: unit/kg/m/l; disponibilidad available/unavailable/unknown; base IVA net/gross/exempt/unknown; tipo de oferente competitor/supplier. Los proveedores se conservan como referencia de compra y no entran como competidores.

Errores: 400 JSON/contrato inválido; 401 sesión; 403 perfil; 404 ruta; 413 tamaño; 422 lote con errores; 409 conflicto de importación/revisión; 503 lectura no disponible. La UI de carga permite confirmar antes de importar y luego revisar equivalencias por separado.

## Activación pendiente y seguridad

No se crearon claves, usuarios, cuentas de servicio, permisos persistentes, acceso anónimo ni servicios externos. El SQL solo reutiliza roles existentes: clientes sin acceso directo a tablas/RPC; servicio backend con select/insert y RPC invoker que comprueba actor administrador activo. RLS habilitado y triggers impiden cambiar/borrar historia. Referencia consultada: https://supabase.com/docs/guides/database/postgres/row-level-security .

Para una futura entrega, con aprobación independiente: revisar/aplicar el SQL en un entorno de pruebas real, desplegar Edge Function y frontend, verificar variables existentes SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY y CRM_APP_URL (origen CORS exacto), FACTO_CURRENCY_MAP_JSON si corresponde y prueba autenticada extremo a extremo. Este módulo no necesita nuevas credenciales para uso manual del CRM. Para automatizar el dot habrá que aprobar identidad, alcance y mecanismo de autorización delegado; no está implementada una identidad automática. Hasta entonces el dot podrá generar un archivo JSON y el administrador importarlo manualmente. Un futuro puente MCP podrá envolver preview/commit conservando revisión humana, sin ampliar permisos.

## Verificación local reproducible

```text
node --experimental-transform-types --test scripts/test-market-study.mjs scripts/test-market-study-security.mjs
node scripts/typecheck-market-study.mjs
node scripts/test-market-study-browser.mjs outputs/market-study-validation
npx eslint src/modules/market-study src/lib/marketStudyApi.ts supabase/functions/market-study supabase/functions/_shared/market-study-contract.ts
npm run build
```

Pruebas SQL en PGlite efímero; fetch falso para API; Chrome headless en contexto nuevo con toda red interceptada y autenticación sintética. No carga .env ni sesiones productivas para las pruebas funcionales. Navegador verifica 1280/390/320 px, simulador sin escritura, importación revisable, aprobación humana, texto investigado seguro, Dashboard vacío/error y desbordamiento. Capturas/results.json en la carpeta de resultados. La compilación normal usa el entorno Vite del repositorio, sin consultar servicios ni desplegar.

## Resultado de la validación — 2026-10-02

- 13/13 pruebas de dominio, API y PostgreSQL aislado aprobadas. Incluyen IVA, descuentos, margen, monedas, null, fechas, equivalencias, tránsito, idempotencia/conflictos, lote atómico, revisión optimista, acceso y fuentes incompletas.
- Prueba de navegador aprobada en 1280/390/320 px: simulación sin escrituras, importación y revisión, contenido como texto, Dashboard con oportunidad/filtros/vacío/error. Red completamente interceptada y usuario sintético. `outputs/market-study-validation/results.json` conserva las llamadas observadas.
- `node scripts/typecheck-market-study.mjs`: aprobado, incluye Edge Function y lectores reutilizados.
- `npm run build`: aprobado (`tsc -b` + Vite). Persiste aviso general de chunks >500 KB; la página del módulo sí se genera en chunk separado (~24,47 KB).
- ESLint del módulo: 0 errores / 0 advertencias. ESLint de `scripts services src supabase`: 14 errores / 14 advertencias, todos fuera de los archivos propios del módulo, iguales al antecedente informado. Informe: `outputs/market-study-lint-full.json`. No se cambió configuración ni se atribuye la deuda previa al módulo. `eslint .` con tmp no se usó como medida de regresión.
- Capturas de escritorio/móvil inspeccionadas: sin desbordamiento de página; tablas desplazables dentro de su contenedor.

No se validó contra una base real ni una sesión productiva; la integración remota requiere aplicar SQL/desplegar con aprobación posterior. No se hicieron commits, push ni despliegues, ni se cambiaron datos o precios reales.
