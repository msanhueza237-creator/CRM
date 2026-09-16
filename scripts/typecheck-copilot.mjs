import ts from "typescript";
const program = ts.createProgram(
  ["scripts/copilot-runtime.d.ts", "supabase/functions/crm-copilot/central.ts"],
  {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    allowImportingTsExtensions: true,
    strict: true,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  },
);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length)
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }),
  );
process.exitCode = diagnostics.length ? 1 : 0;
