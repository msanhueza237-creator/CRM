// Local compile-only declarations for the pinned Deno PDF dependency.
declare module "npm:pdf-lib@1.17.1" {
  export class PDFDocument {
    static load(bytes: Uint8Array): Promise<PDFDocument>;
    static create(): Promise<PDFDocument>;
    getPageCount(): number;
    copyPages(source: PDFDocument, pages: number[]): Promise<unknown[]>;
    addPage(page: unknown): void;
    setTitle(title: string): void;
    save(): Promise<Uint8Array>;
  }
}
declare module "npm:unpdf@1.8.1" {
  export function extractText(bytes: Uint8Array, options: { mergePages: false }): Promise<{ text: string[]; totalPages: number }>;
}
