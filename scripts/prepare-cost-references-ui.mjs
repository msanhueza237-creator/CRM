import { readFile, writeFile, mkdir } from 'node:fs/promises';
import ts from 'typescript';

// Render the production components against an explicit in-memory API, never the CRM.
async function components(path) {
  const source = await readFile(path, 'utf8');
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return ts.transpileModule(tree.statements.filter(node => !ts.isImportDeclaration(node))
    .map(node => node.getText(tree).replace(/^export /, '')).join('\n'), {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const detail = await components('src/modules/foreign-trade/ForeignTradeOperationDetail.tsx');
const costing = await components('src/modules/foreign-trade/ForeignTradeCostingPanel.tsx');
await mkdir('tmp', { recursive: true });
await writeFile('tmp/cost-references-ui.jsx', `
import React, {useState,useEffect,useMemo,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {AlertTriangle,ArrowLeft,Boxes,CheckCircle2,CircleDollarSign,Container,FlaskConical,Edit3,Link2,LoaderCircle,PackageSearch,Plus,RefreshCw,ScanSearch,Save,Scale,Trash2,X,Calculator,ChevronLeft,ChevronRight,FileSpreadsheet,Landmark,PackageCheck,WalletCards} from 'lucide-react';
import {calculateForeignTradeCosting} from '/src/modules/foreign-trade/foreignTradeCostEngine.ts';
import {hasSimulatedCosts,referenceCostEditValues} from '/src/modules/foreign-trade/foreignTradeCostReferences.ts';
import {formatForeignTradeProductIdentity,getForeignTradeProductIdentity} from '/src/modules/foreign-trade/foreignTradeProductIdentity.ts';
import '/src/styles.css';
import '/src/modules/foreign-trade/foreignTradeMobile.css';
const base={id:'test',operation_id:'test',category:'international_freight',name:'Flete internacional',amount_original:4690,currency:'USD',exchange_rate_clp:1000,amount_clp:4690000,allocation_method:'cbm',source_type:'real',metadata:{reconciliation_id:'old'},updated_at:'2026-09-25T12:00:00Z'};
let data={operation:{id:'test',title:'Importación de prueba local',reference:'QA-COSTOS',status:'production',operation_type:'proforma',base_currency:'USD',exchange_rate_clp:1000,estimated_arrival:'2026-11-15',value_usd:1000},supplier:null,costs:[base],lines:[{id:'line',product_name:'Herramienta de prueba',quantity:10,unit_factory_cost:100,currency:'USD',fob_total:1000,cif_total:5690,cbm_total:1}],scenarios:[],totals:{line_count:1,registered_merchandise:1000,total_cbm:1,gross_weight_kg:0,units:10,costs_clp:4690000,costs_without_clp:0}};
function useForeignTradeOperation(){const [detail,setDetail]=useState(data);return {detail,loading:false,error:'',refresh:async()=>setDetail({...data,costs:[...data.costs]})};}
const simulateForeignTradeCosts=async()=>{data={...data,costs:data.costs.map(c=>({...c,source_type:'simulated',metadata:{simulation_reference:{cost:c}}}))};return {converted_costs:data.costs.length}};
const upsertForeignTradeCostLine=async f=>{data={...data,costs:data.costs.map(c=>({...c,amount_original:Number(f.amountOriginal),amount_clp:Number(f.amountOriginal)*Number(f.exchangeRateClp),metadata:{...c.metadata,amount_basis:f.amountBasis,vat_rate_percent:Number(f.vatRatePercent)}}))}};
const deleteForeignTradeCostLine=async()=>{};
const saveForeignTradeCostingScenario=async()=>{};
const ForeignTradeDocumentsPanel=()=>null, ForeignTradeIntelligencePanel=()=>null, ForeignTradeExpenseReconciliationPanel=()=>null;
const ForeignTradeCostingPanel=(()=>{${costing};return ForeignTradeCostingPanel;})();
${detail}
createRoot(document.getElementById('root')).render(<main style={{padding:16,maxWidth:1280,margin:'auto'}}><ForeignTradeOperationDetail operationId="test" statuses={[]} suppliers={[]} costParameters={[{code:'cl_general_ad_valorem',active:true,numeric_value:0},{code:'cl_import_vat',active:true,numeric_value:19},{code:'cl_sales_vat',active:true,numeric_value:19}]} onBack={()=>{}} onDelete={async()=>{}} onChanged={async()=>{}}/></main>);
`);
await writeFile('tmp/cost-references-ui.html', '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Costos: prueba local</title><div id="root"></div><script type="module" src="/tmp/cost-references-ui.jsx"></script></html>');
console.log('Prepared local cost-reference UI fixture (no production API).');
