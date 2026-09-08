# Costos y simulaciones de negociacion

`get_product_profitability` consulta el detalle Facto por SKU y lista de precios, con permiso del dominio finanzas. No depende del resumen de inventario ni de margenes historicos del agente.

- Precio neto y costo tienen fechas y fuentes separadas.
- Margen bruto = (precio neto - costo) / precio neto. Recargo = (precio neto - costo) / costo.
- Costo cero o ausente, identidad ambigua y monedas distintas impiden certificar el calculo.
- Si falta moneda del costo, los escenarios se marcan condicionales a la moneda del precio. No son conversiones verificadas.
- Una confirmacion expresa puede guardarse en `accounting_entities.settings.copilot_cost_currency_confirmations`, por SKU, ID Facto, valor de costo, moneda y fecha. Si cambia el costo o la identidad, deja de aplicarse.
- El usuario confirmo 360 CLP para FLARE 3/8 (Facto 85). Se registro la configuracion y un evento en `accounting_audit_events`; no se modificaron Facto, asientos o valorizaciones.
- Los pisos son matematicos sobre el costo registrado, no autorizaciones comerciales. No existe una politica global de descuento inferida.
- El margen minimo solo se calcula cuando se solicita. Se redondea el precio hacia arriba a pesos enteros en CLP o centavos para otras monedas. No se convierten monedas.
- Los ejemplos predeterminados de descuento 0/5/10/15/20 son ilustrativos, no recomendaciones.
- Se usan enteros de seis decimales para importes y porcentajes; se rechazan escenarios fuera de precision.
- Los datos internos no se agregan a la lista Excel comercial para clientes.

Caso verificado: precio 691,90 CLP, costo confirmado 360 CLP, diferencia bruta 331,90 CLP y margen 47,969359%. Con 10% de descuento: precio 622,71 CLP y margen 42,188177%. Objetivo solicitado de 30%: precio minimo calculado 515 CLP, antes de otros gastos.
