---
name: commit
description: Ejecuta el workflow de git (add, commit, push) para subir cambios al repositorio con un mensaje especificado.
---

# Git Commit Workflow Skill

Este skill le permite al asistente ejecutar de forma automatizada las operaciones de git para añadir, commitear y subir el código al repositorio, siempre y cuando el usuario lo solicite explícitamente.

## Instrucciones para el Asistente:

Cuando el usuario invoque este workflow (ej. "ejecuta commit", "haz commit: <mensaje>", o similar):
1. **Validar el mensaje de commit:** Si el usuario no ha especificado un mensaje, solicítalo educadamente antes de continuar.
2. **Ejecutar comandos:** Con el mensaje validado, ejecuta en orden y de forma automatizada los siguientes comandos en la raíz del proyecto usando `run_command`:
   - `git add .`
   - `git commit -m "<mensaje_del_usuario>"`
   - `git push`
3. **Manejar errores:** Si ocurre un error (por ejemplo, conflictos al hacer push o archivos sin cambios), infórmaselo al usuario inmediatamente con el detalle del error para que decida cómo proceder.
