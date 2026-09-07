import { buildFactoSyncPreview } from "./normalization.ts";
import { SafeLogger } from "./logger.ts";
import type { FactoApiReader, FactoBrowserReader, FactoSyncPreview } from "./types.ts";

export class FactoSyncService {
  constructor(
    private readonly api: FactoApiReader,
    private readonly browser: FactoBrowserReader,
    private readonly logger: SafeLogger,
  ) {}

  async previewReceivables(fromDate: string, toDate: string): Promise<FactoSyncPreview> {
    validateRange(fromDate, toDate);
    this.logger.info("Iniciando lectura API Facto.", { stage: "api_start", from_date: fromDate, to_date: toDate });
    const apiResult = await this.api.readIssuedDocuments(fromDate, toDate);
    this.logger.info("Lectura API Facto terminada.", {
      stage: "api_complete",
      documents: apiResult.documents.length,
      pages: apiResult.pagesRead,
      complete: apiResult.complete,
    });

    this.logger.info("Iniciando lectura web complementaria de Facto.", { stage: "browser_start", read_only: true });
    const browserResult = await this.browser.readUnpaidDocuments(fromDate, toDate);
    this.logger.info("Lectura web Facto terminada.", {
      stage: "browser_complete",
      section: browserResult.section,
      rows: browserResult.rows.length,
      pages: browserResult.pagesRead,
      complete: browserResult.complete,
    });

    const preview = buildFactoSyncPreview(apiResult, browserResult);
    if (!preview.coverage.complete) {
      this.logger.warn("La lectura quedó parcial y no podrá aplicarse.", {
        stage: "preview_partial",
        items: preview.items.length,
      });
    } else {
      this.logger.info("Previsualización construida sin escribir datos financieros.", {
        stage: "preview_complete",
        items: preview.items.length,
        bank_movements_created: 0,
        journal_entries_created: 0,
      });
    }
    return preview;
  }
}

function validateRange(fromDate: string, toDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    throw new Error("El período debe usar fechas AAAA-MM-DD.");
  }
  if (fromDate > toDate) throw new Error("La fecha inicial no puede ser posterior a la fecha final.");
  if (toDate > new Date().toISOString().slice(0, 10)) throw new Error("El período no puede terminar en el futuro.");
}
