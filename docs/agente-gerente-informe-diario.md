# Informe gerencial diario

Solicitud: un informe a las 12:00 America/Santiago, con datos de los modulos.
El contenido y horario no modifican destinatarios ni habilitan nuevos canales.

## Agenda y entrega

- El coordinador existente consulta cada 30 segundos; sus antiguos cuatro
  horarios quedan normalizados en el servidor a una clave unica por dia.
- El corte se solicita desde las 12:00, con recuperacion hasta las 20:00 si
  hubo una interrupcion. La entrega depende de la cola y disponibilidad de Gmail.
- La base valida dia, hora, clave y origen diario y serializa agenda/entrega.
- Un mensaje ya enviado ese dia, incluso de la agenda anterior, impide otro.
- No se reenvian colas de dias anteriores. Se conservan con estado omitido.
- Una entrega con resultado incierto no se reintenta automaticamente, evitando
  duplicados. Se conserva el fallo para revision en las comunicaciones del agente.
- Analisis manuales y antiguos modos morning/review no producen notificaciones.

## Contenido

Hasta cinco prioridades: cartera incompleta/vencida, resultados negativos,
publicaciones fallidas, llegadas reales comprometidas, aprobaciones pendientes,
seguimientos y disponibilidad sin verificar. Se prioriza impacto y accion.
Las simulaciones no disparan alertas de llegada. No se inventan costos ni caja.

Incluye bancos, por cobrar, por pagar y cheques separados; resultados con periodo,
base y provisionalidad; corte de cartera; cambios de importes contra el ultimo
informe diario. No compara ventas si cambio el inicio del periodo o base.
El respaldo completo permanece desplegable en el CRM.

## Publicacion y pruebas

Aplicar solo `supabase/executive_daily_noon.sql` con respaldo previo de las dos
funciones SQL y configuracion. No ejecutar el instalador original de agentes,
porque conserva los valores antiguos de la agenda.

Publicar crm-agent/index.ts, module-reports.ts, executive-daily.ts y
gmail-integration/index.ts, ademas del frontend. No requiere SQL financiero.

Pruebas: test-executive-daily.mjs (incluye PostgreSQL embebido),
test-business-module-reports.mjs, test-agents-dashboard.mjs, test:copilot y build.
La prueba de interfaz usa fixtures, con Chrome independiente y sin sesion real.
