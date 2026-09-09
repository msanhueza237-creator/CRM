# Panorama del negocio

El inicio general reutiliza `accounting-center/summary` y `foreign_trade_dashboard_summary`, sin crear tablas, movimientos o asientos. No suma los informes de agentes a los registros financieros.

- Finanzas: administrador y finanzas. Importaciones y conexiones: administrador.
- Cartera parcial: se oculta el importe y se muestra En revisión, igual que en Finanzas.
- Fallos de lectura: No disponible; nunca un cero sustituto. La ausencia de configuración no muestra cifras demo.
- Conteos comerciales y editoriales: consultas con conteo exacto, no longitud de una primera página. Las etapas comerciales muestran distribución actual, no una conversión histórica inferida.
- Período: acumulado disponible del año o selección mensual. Los enlaces al estado de resultados conservan fechas y tipo de informe. Fechas inválidas recuperan los valores habituales del informe.
- Tesorería: corte y respaldo bancario separados de la fecha de actualización del dashboard. Cheques no sumados a disponible. Resultado siempre marcado provisional.
- Actualización manual, al recuperar foco después de dos minutos y cada cinco minutos mientras la página sea visible. No fuerza sincronizaciones ni escrituras en Facto.

## Verificación

`node --experimental-strip-types --test scripts/test-dashboard.mjs`

`node scripts/test-dashboard-ui.mjs` con Vite en el puerto 5183; `DASHBOARD_UI_URL` permite otro origen. Usa un perfil aislado de Chrome y datos ficticios interceptados: no consulta datos reales ni modifica producción. Cubre 1440, 1280, 768, 390 y 360 píxeles, permisos, selección mensual, enlaces, lecturas fallidas y cartera suprimida.

Se verificaron por separado los dos endpoints existentes en producción, en modo lectura.
