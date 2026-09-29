# Rentabilidad por cliente

Consulta de solo lectura, disponible para Administracion y Finanzas. El especialista existente de Finanzas atiende esta informacion a traves del Gerente; texto y voz conservan el mismo orquestador, permisos y auditoria.

## Definicion

- Utilidad bruta CLP = ventas netas sin IVA - costo vinculado al documento.
- Margen bruto % = utilidad bruta / ventas netas positivas * 100.
- No es utilidad neta ni caja. No se distribuyen gastos generales sin un criterio contable aprobado.
- Se agrupa por empresa contable y RUT normalizado, nunca solo por nombre. Identidad ausente queda pendiente.
- Periodo por fecha de emision de ventas y notas de credito; evidencia de costos contabilizados hasta el cierre solicitado. Puede diferir de resultados por fecha de asiento. No modifica los resultados anteriores del dashboard.
- El costo requiere par costo/inventario balanceado y vinculado. Notas de credito usan la verificacion existente de referencias/reversas, nunca un porcentaje estimado del costo.
- Un cliente con costos o reversas pendientes queda fuera del ranking; sus importes de utilidad y margen son nulos. Costo ausente no es cero. Ventas netas no positivas tampoco generan margen ni ranking.
- Se preservan perdidas verificadas (no se truncan a cero). La lista puede contener menos de diez clientes.

## Integracion

- `accounting-center/customer-profitability?from=YYYY-MM-DD&to=YYYY-MM-DD&query=...&limit=10`: GET autenticado. Empresa activa unica, fechas reales no futuras, limite 1 a 100. Sin SQL suministrado por el cliente.
- `accounting-center/summary`: incluye rankings anual y mensuales, reutilizando documentos y libro mayor ya leidos. Un fallo del mayor no produce un ranking vacio certificado.
- `get_customer_profitability`: herramienta del Copiloto, dominio finance, con `sort_by=gross_profit|margin`, periodo y filtro opcional de cliente/RUT. Consulta el endpoint con el token del usuario.
- Ambos caminos ejecutan `accounting-center/customer-profitability.ts` y comparten contrato de tipos. No hay migraciones ni variables nuevas.

## Verificacion y despliegue

Pruebas: `scripts/test-customer-profitability.mjs`, `test-dashboard-sales.mjs`, `test-credit-note-costs.mjs`, `test-agent-manager.mjs`, `test-copilot-enterprise.mjs`, `test-copilot.mjs`, `test-accounting-bootstrap-memory.mjs`, typecheck Copiloto y build.

Publicar frontend mediante Dokploy y los archivos modificados de accounting-center/crm-copilot junto al contrato `_shared/customer-profitability-contract.ts`. Conservar copia de archivos previos y referencia de imagen. No ejecutar migraciones ni asientos. Revalidar dashboard y una pregunta real al Copiloto despues de publicar ambas capas.
