import ts from 'typescript';
import fs from 'node:fs';
const installedTypes=JSON.parse(fs.readFileSync('node_modules/@supabase/supabase-js/package.json','utf8')).types;
const program=ts.createProgram(['supabase/functions/crm-agent/whatsapp-conversation.ts','supabase/functions/_shared/whatsapp-content.ts','supabase/functions/_shared/direct-message.ts','supabase/functions/crm-agent/message-recipients.ts','supabase/functions/gmail-integration/direct-email.ts'],{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,noEmit:true,allowImportingTsExtensions:true,strict:true,skipLibCheck:true,baseUrl:'.',paths:{'https://esm.sh/@supabase/supabase-js@2.45.4':[`node_modules/@supabase/supabase-js/${installedTypes}`]},types:[],lib:['lib.es2023.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts']});
const inboxProgram=ts.createProgram(['supabase/functions/crm-agent/whatsapp-inbox.ts','supabase/functions/crm-agent/whatsapp-template-manager.ts','supabase/functions/crm-agent/whatsapp-template-model.ts','supabase/functions/crm-agent/whatsapp-delivery.ts'],program.getCompilerOptions());
const diagnostics=[...ts.getPreEmitDiagnostics(program),...ts.getPreEmitDiagnostics(inboxProgram)];
if(diagnostics.length)console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n'}));
else console.log('PASS WhatsApp conversation backend types');
process.exitCode=diagnostics.length?1:0;
