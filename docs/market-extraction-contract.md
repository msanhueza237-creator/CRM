# Contrato de extracción v1 — implementación local, piloto desactivado

Autenticación: `X-Climactiva-Api-Key`, scope `market-research:extract`, vinculación vigente al proveedor investigador/SKU y administrador autorizante activo. Nunca enviar claves Gemini/DeepSeek, JWT administrativo o service_role desde el worker.

`GET /market-research/extraction-policy` devuelve `{schema_version:1, enabled:false, revision:1, choice:"deepseek:deepseek-flash", daily_usd:1, pilot_usd:5, daily_jobs:50, public_hosts:[]}`. Son topes de piloto, no autorización de gasto. La activación requiere configuración backend aprobada; no está expuesta en el selector.

`POST /market-research/extract` (Content-Type application/json, máximo 28.000 bytes):

```json
{"schema_version":1,"batch_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","selection_revision":1,"job_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","provider":"investigador-autorizado","sku":"SKU-A","source":{"url":"https://competidor.example/producto","observed_at":"2026-10-03T22:00:00.000Z","public_product_page":true,"text":"Bomba Modelo ABC. Precio 11900 CLP IVA incluido. Unidad."}}
```

El primer trabajo reserva y fija la selección/tarifa/revisión del lote. Los siguientes trabajos con el mismo batch_id mantienen esa selección aunque el administrador cambie la actual. La revisión enviada debe coincidir con la del lote; un lote nuevo exige revisión actual. Sin fallback ni modelo/prompt/tools arbitrarios en el request. Cada job_id es único por integración; un cambio de contenido/batch/revisión con el mismo ID da 409.

El backend es el **único titular del ledger, reserva y contabilización de inferencia**. El worker no llama al modelo, no reserva otro presupuesto para estas llamadas y no reintenta inferencias por su cuenta. Puede contabilizar separadamente su obtención de fuentes, claramente distinguida.

Respuesta de trabajo: `{schema_version:1, job_id, batch_id, state, selection, sku, source_url, attributes, usage, error_code, requires_review:true}`. `selection` contiene `revision`, `provider`, `model`, `input_usd_per_million`, `output_usd_per_million`, `rate_source`, `rate_checked_at`. `usage` contiene `input_tokens`, `output_tokens`, `estimated_usd` (null si desconocidos) y `reserved_usd`. El costo es estimación conservadora, no factura.

`attributes` es una lista de `{field,value,quote}`. Fields permitidos: `title,brand,model,price,currency,vat,unit,package_quantity,availability`. value/quote son textos literales, sin normalizar moneda, IVA o unidades; quote debe existir en source.text y contener value. Atributos ausentes se omiten. Nunca crea observaciones, aprueba equivalencias ni modifica precios. El worker puede preparar una importación posterior validada/revisable por el contrato de observaciones existente.

Estados/HTTP:
- 200 `completed`: resultado persistido y reutilizable; no repetir inferencia.
- 200 `failed`: fallo terminal, error_code seguro y reserva conservada; no reintentar automáticamente con ID nuevo.
- 200 `unknown`: timeout/resultado no confirmado; reserva conservada, no se vuelve a llamar al proveedor.
- 202 `running`: otro request posee el trabajo; consultar reenviando exactamente el mismo request.
- 400/413/415/422: contrato/cuerpo inválido; no llamada.
- 401/403: credencial/scope/vinculación/SKU no autorizado; no llamada.
- 409: identidad o revisión en conflicto; no reasignar IDs automáticamente.
- 429: concurrencia global 1, cuota diaria o presupuesto agotado; no llamada nueva. Reenviar misma identidad posteriormente.
- 503: piloto/configuración/proveedor no disponible o persistencia no confirmada. Reenviar solo la misma identidad; el ledger impide repetir una llamada cuyo resultado se desconoce.

Fuentes: HTTPS y hostname exacto dentro de lista aprobada, sin IP/localhost/puertos/credenciales/query/fragmento, observación no futura y no mayor de 7 días. Máximo 20.000 bytes de texto público; no HTML, correos, teléfonos de contacto, costos/clientes/datos internos ni instrucciones. No se descarga la URL desde el proxy. El worker debe garantizar origen público y filtrar datos personales; la validación sintáctica no demuestra por sí sola que un texto sea público o verdadero. El contenido se trata siempre como datos no confiables.

Límites: una llamada por trabajo, salida 1.024 tokens, timeout 30s, reserva por bytes de entrada más margen de instrucciones y salida máxima; reserva retenida ante fallos ambiguos. Sin reintentos del proveedor. Tarifas fechadas y configuración fijadas por lote. El selector administrativo modifica solo selección para lotes nuevos, con control de revisión; no activa el piloto ni cambia otros módulos.
