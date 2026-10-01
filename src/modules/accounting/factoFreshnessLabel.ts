export function factoFreshnessLabel(state?: string): string {
  switch (state) {
    case "mirror_consolidated": return "Período consolidado en el espejo";
    case "failed": return "Último intento fallido";
    case "cancelled": return "Último intento cancelado";
    case "partial": return "Consolidación con observaciones";
    case "running": return "Consolidación en curso";
    case "old_reading": return "Lectura del conector de más de 24 horas";
    case "pending": return "Consolidación pendiente";
    default: return "Actualización sin confirmar";
  }
}
