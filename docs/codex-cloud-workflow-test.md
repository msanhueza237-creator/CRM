# Prueba del flujo Codex Cloud → GitHub

Fecha: 7 de octubre de 2026.

Esta rama temporal permite comprobar el flujo de desarrollo desde Codex Cloud,
usando el checkout `/workspace/CRM`, sin depender de un equipo local con Windows.

La prueba consiste en crear una rama desde `main`, agregar este único documento,
verificar el alcance del cambio, crear un commit y publicar la rama en GitHub.
La publicación se comprueba comparando el commit local con la referencia remota.

Este documento no cambia código funcional, dependencias ni configuración.
La prueba no incluye un merge a `main`, despliegues en Dokploy ni cambios en
Supabase. La rama se conserva para poder revisar el resultado.
