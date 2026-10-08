# Asistente comercial de WhatsApp

## Estado

Implementación del piloto de propuestas. El motor `whatsapp-automation-plan.ts` se prueba sin red,
modelos ni base de datos. No está conectado al webhook ni al envío. Todos sus
resultados tienen `canSend: false`; son borradores o decisiones de derivación.
No se activa envío automático ni se crea otro agente. La publicación del piloto
usa la integración Tiendanube existente y no requiere nuevas credenciales o tablas.

## Primer flujo preparado

- Una consulta de precio/stock con SKU, nombre completo o enlace exacto y evidencia Tiendanube reciente
  genera un borrador con moneda explícita. No promete reserva de stock.
- Datos incompletos, futuros o con más de 15 minutos requieren consultar de nuevo
  la fuente. El límite es una política inicial del piloto, no una garantía de
  frecuencia de la sincronización existente.
- Variantes/SKU ambiguos piden aclaración. Productos no publicados no se ofrecen.
- Ventana de atención cerrada, bajas o intervención humana inhiben el motor.
- Audios/imágenes quedan pendientes de transcripción/identificación, sin fingir
  interpretación. Seguimiento exige un pedido y una identidad verificados.
- Cotizaciones formales quedan pendientes de comprobar una operación soportada
  de Facto; el conector revisado solo tiene consultas. No emitir una factura para
  sustituir una cotización.

## Propuestas en la bandeja

El endpoint autenticado `GET whatsapp-assistant-preview` permite al administrador
o vendedor consultar una propuesta para el último mensaje entrante. Lee el
catálogo existente, sin actualizarlo ni enviar mensajes. La bandeja muestra
“Proponer respuesta” y “Usar propuesta”; este último solo copia el texto al
editor y no reemplaza texto ni adjuntos del vendedor. El envío sigue siendo manual.

El usuario confirmó que la tienda opera en pesos chilenos. Al publicar, configurar
`WHATSAPP_STORE_CURRENCY=CLP` en el entorno del backend `crm-agent` (no en el
frontend). Esta confirmación no modifica todavía el entorno de producción. Se usa el precio promocional
de la variante cuando existe. Stock sin gestión o desconocido requiere revisión.
La antigüedad considera tanto `source_updated_at` como `last_synced_at`: volver
a normalizar un espejo viejo no lo convierte en evidencia reciente.

## Lectura actual preparada

Con `WHATSAPP_LIVE_CATALOG_ENABLED=true`, el backend consulta la variante identificada
mediante un único GET a la API Tiendanube, incluso si el espejo parece reciente.
Los IDs provienen del catálogo sincronizado; no se visitan enlaces del cliente.
El resultado debe conservar producto/variante/SKU, estar publicado y tener datos
válidos. Respuestas 401/429, fallos, productos retirados o variantes ambiguas
impiden usar el precio viejo. La consulta tiene límite de 5 segundos y 256 KiB;
no hay reintentos automáticos ni escrituras a Tiendanube o a la base.

La API versionada coincide con la utilizada en el conector existente. Su
compatibilidad y la presencia de las credenciales en `crm-agent` todavía requieren
comprobación real antes de publicar. Las pruebas usan respuestas sintéticas.
No se han copiado ni leído credenciales de producción. Ver los nombres de
configuración en `whatsapp-agent-env.example`; activación inicial deshabilitada.

## Integración pendiente

1. Verificar la consulta actual preparada con la tienda real, aplicar `CLP`
   y comprobar la configuración del backend antes de publicar. No aceptar
   evidencia ni precios aportados por el cliente como fuente autorizada.
2. El motor resuelve SKU, nombre completo (sin depender de tildes), enlaces
   HTTPS presentes en el catálogo y referencias Meta por ID de variante. No
   visita enlaces aportados por el cliente. Un enlace compartido por varias
   variantes o referencias contradictorias exige aclaración. Queda pendiente
   resolver nombres parciales y contexto conversacional con identificación fiable.
3. Publicar y validar el flujo de propuestas preparado en la bandeja, sin envío
   automático, después de revisar el despliegue y su autorización.
4. Incorporar descarga autenticada de medios Meta, límites, transcripción y visión
   con proveedor simulado primero. Correlacionar una imagen con el catálogo y
   pedir datos si no hay identificación fiable.
5. Incorporar pedidos Tiendanube con verificación de identidad. Consultar reglas
   reales de despacho, sin inferir tarifas, plazos ni tracking faltantes.
6. Comprobar el contrato Facto de cotización. Recoger RUT, razón social, dirección,
   artículos y cantidades; confirmar resumen antes de crear el documento.
7. Integrar modelos con presupuesto/telemetría explícitos. La política del
   Copiloto no cubre automáticamente este nuevo canal ni la transcripción.
8. Preparar envío automático separado del envío humano existente: reserva
   persistente por ID entrante, control de ventana/baja/intervención, concurrencia
   por hilo, ausencia de reintentos ante resultado incierto e interruptor de
   apagado. No simular una confirmación humana para eludir la ruta actual.
9. Probar end-to-end con fixtures y un piloto autorizado antes de activar envíos
   reales. Consultas no resueltas y correcciones alimentan una cola de revisión;
   no se convierten automáticamente en hechos o entrenamiento del modelo.

## Comprobaciones

```bash
node --experimental-transform-types --test scripts/test-whatsapp-automation-plan.mjs
node --experimental-transform-types --test scripts/test-whatsapp-automation-preview.mjs
node --experimental-transform-types --test scripts/test-whatsapp-automation-e2e.mjs
node --experimental-transform-types scripts/test-whatsapp-conversation-browser.mjs
node scripts/typecheck-whatsapp.mjs
```

Las pruebas no requieren secretos ni publican cambios. El acceso administrativo
HTTPS ya verificado a Dokploy permite consultar y preparar futuras promociones;
una escritura/despliegue requiere autorización específica y comprobar cómo se
publican los archivos de las Edge Functions compartidas.
