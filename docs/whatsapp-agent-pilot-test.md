# Prueba del asistente WhatsApp en Cloud

Fecha: 2026-10-08. Datos y credenciales sintéticos; ninguna consulta real a
Tiendanube, Meta, Facto o clientes. Sin escrituras a bases, publicaciones o respaldos.

## Resultado funcional

Se ejercitó el backend existente, desde la conversación hasta la lectura de
Tiendanube simulada, la selección de variante y la propuesta mostrada en el CRM.
En navegador se comprobó que copiar la propuesta no envía el mensaje ni sustituye
un texto ya escrito. Después de una respuesta humana, la propuesta se invalida.
El envío manual de la prueba también usa un receptor simulado.

Ejemplo de cliente ficticio: «precio y stock LX1030».

El espejo tenía un precio antiguo de 34.500 CLP. La respuesta simulada de la API
indicó precio normal 40.000 CLP, promoción 32.000 CLP y stock 2. El agente propuso:

> Manómetro R32 (LX1030). Precio registrado en la tienda: 32.000 CLP. La tienda registra disponibilidad; se confirma al realizar el pedido.

## Casos comprobados

| Consulta o condición | Resultado |
| --- | --- |
| SKU, nombre completo o enlace conocido | Borrador de la variante identificada |
| Varias variantes o referencia incompleta | Solicita aclaración |
| Precio promocional actual distinto del espejo | Usa precio actual de la variante |
| Stock actual cero | Informa sin stock |
| Stock desconocido o sin gestión numérica | Revisión humana |
| Producto retirado, variante sustituida o duplicada | No propone precio antiguo |
| API 401, 429, fallo, JSON inválido o demasiado grande | Derivación sin revelar detalles internos |
| Baja, ventana de 24 h cerrada o mensaje ya respondido | No propone respuesta comercial |
| Audio o imagen | Deriva: interpretación todavía pendiente |
| Cotización formal o seguimiento | Deriva: operación/verificación todavía pendiente |

## Verificación

- 63 pruebas aprobadas: motor, catálogo, recorrido integrado e historial existente.
- Navegador aprobado en 320, 390 y 1280 px, sin comunicaciones reales.
- Tipos del backend y compilación del frontend aprobados.

## Límite del resultado

Esto valida el piloto de propuestas de texto y sus controles con fixtures.
No demuestra conexión real a la tienda desde crm-agent, entrega por Meta,
interpretación de medios, IA para preguntas complejas ni emisión de cotizaciones.
El agente no está publicado y no envía automáticamente. Para un piloto real falta
comprobar la configuración y el método de publicación de las funciones compartidas,
revisar los cambios y obtener autorización específica para publicarlos.
