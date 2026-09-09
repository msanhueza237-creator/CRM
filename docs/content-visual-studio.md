# Estudio visual del Centro de Contenido

## Alcance

Cinco composiciones independientes para la imagen principal, mas la opcion Original:

| Diseno | Composicion | Uso |
| --- | --- | --- |
| Ficha tecnica | Titular horizontal, foto y especificaciones | Herramientas y componentes con datos tecnicos |
| Protagonista | Fotografia grande y banda editorial verde | Presentacion de producto |
| Industrial | Columna lateral roja y referencia destacada | Equipos y herramientas |
| Laboratorio | Fondo oscuro cuadriculado y datos en contraste | Catalogo tecnico |
| Oferta | Precio registrado o dato destacado, foto y especificaciones | Comunicacion comercial |

Marca CLIMACTIVA, lienzo de 1080 x 1080 px, JPEG. Se conserva una sola imagen por publicacion. El encuadre aprovecha el espacio blanco o transparente alrededor del producto conservando todos los pixeles no blancos y un margen de seguridad. Las fotografias con contexto hasta los bordes mantienen el encuadre completo. No se altera el archivo fotografico original.

Los criterios de jerarquia y composicion se contrastaron con las habilidades HyperFrames Creative y Frontend Design de Anthropic. Esta entrega es de imagenes estaticas, no incluye generacion ni publicacion de videos.

Habilidad complementaria identificada: [Frontend Design de Anthropic](https://skills.sh/anthropics/skills/frontend-design). No se instalaron dependencias ni habilidades externas. Su comando de instalacion, si se aprueba, es `npx skills add anthropics/skills --skill frontend-design`.

## Datos y controles

- La vista previa usa la imagen principal del producto guardado en content_products. El servidor resuelve su URL, no acepta una URL libre en la consulta de vista previa.
- La ruta conserva el permiso content.generate. No crea publicaciones ni consume generacion IA al probar estilos.
- Las especificaciones se toman de pares de celdas de la tabla explicita Parametro / Detalle Tecnico en la descripcion del catalogo. Sin esa tabla, se muestran SKU, marca y categoria existentes; no se infieren medidas ni certificaciones.
- Los textos editados se conservan al alternar composiciones. Cambiar de producto o restablecer textos vuelve a la ficha de ese producto.
- Aplicar diseno solo modifica borradores del producto seleccionado en estado draft o pending_approval. Mantiene cuerpo, hashtags y estado de aprobacion; no publica ni programa en Meta.
- El precio destacado es el precio promocional o precio registrado del producto, sin calcular ni inventar descuentos o tratamiento tributario.
- Las imagenes guardadas en publicaciones anteriores no se regeneran automaticamente.

## Pruebas

Ejecutar el servidor Vite en 127.0.0.1:5190 y luego:

```powershell
npm run test:content
node scripts/test-content-creatives.mjs
npm run build
```

La prueba de navegador usa Chrome headless, sustituye la API y no escribe datos externos. Verifica cinco composiciones distintas por pixeles, descarga JPEG, datos tecnicos, cambio de textos y producto, fallo y reintento de imagen, una imagen compartida entre canales, conservacion de textos y aprobacion, y anchos 1440, 768, 390 y 360 px. Si estan disponibles, utiliza las muestras de catalogo de tmp/content-studio; en otro equipo usa fixtures sinteticos identificados como prueba.

Las capturas y la galeria local quedan en outputs/content-designs. No forman parte del bundle de produccion.

## Publicacion del cambio

Se requieren el frontend y la funcion content-center. No requiere migracion SQL ni cambios de configuracion contable. Publicar la funcion antes del frontend para que la nueva vista previa tenga disponible creative-source?productId=....
