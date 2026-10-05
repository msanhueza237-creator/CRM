import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const repo=process.cwd();
const baselineArg=process.argv.find(v=>v.startsWith('--baseline='));
const baseline=baselineArg?path.resolve(baselineArg.slice(11)):repo;
const git=(...args)=>execFileSync('git',args,{cwd:baseline,encoding:'utf8',windowsHide:true});
const head=git('rev-parse','HEAD').trim();
const output=path.join(repo,'outputs','market-release');fs.mkdirSync(output,{recursive:true});
const root=fs.mkdtempSync(path.join(output,'candidate-')),source=path.join(root,'source');fs.mkdirSync(source);
const top=git('ls-tree','--name-only','HEAD').trim().split(/\r?\n/);
const selected=top.filter(n=>['src','supabase','scripts','public','index.html','package.json','package-lock.json','vite.config.ts','eslint.config.js','tsconfig.json','tsconfig.app.json','tsconfig.node.json'].includes(n));
const archive=path.join(root,'baseline.tar');execFileSync('git',['archive','--format=tar',`--output=${archive}`,'HEAD',...selected],{cwd:baseline,windowsHide:true});
execFileSync('tar',['-xf',archive,'-C',source],{windowsHide:true});
const overlay=['src/modules/market-study','src/lib/marketStudyApi.ts','supabase/functions/market-study','supabase/functions/market-research','supabase/functions/_shared/market-study-contract.ts','supabase/market_study.sql','supabase/market_research_api.sql','supabase/market_extraction.sql','src/App.tsx','src/modules/layout/AppLayout.tsx','src/modules/dashboard/DashboardPage.tsx',...fs.readdirSync(path.join(repo,'scripts')).filter(n=>/^(test-market-|typecheck-market-|prepare-market-research|build-market-functions)/.test(n)&&n.endsWith('.mjs')).map(n=>'scripts/'+n),'docs/market-extraction-contract.md','docs/market-extraction-openapi.json','docs/market-research-openapi.json','docs/market-research-example.json'];
for(const file of overlay){const dest=path.join(source,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.cpSync(path.join(repo,file),dest,{recursive:true});}
// Preserve baseline settings; add only the module's shared contract include.
const tsPath=path.join(source,'tsconfig.app.json'),ts=JSON.parse(fs.readFileSync(tsPath,'utf8'));if(!ts.include.includes('supabase/functions/_shared/market-study-contract.ts'))ts.include.push('supabase/functions/_shared/market-study-contract.ts');fs.writeFileSync(tsPath,JSON.stringify(ts,null,2)+'\n');
fs.symlinkSync(path.join(repo,'node_modules'),path.join(source,'node_modules'),'junction');
for(const dir of ['outputs/market-extraction','outputs/market-research-e2e'])fs.mkdirSync(path.join(source,dir),{recursive:true});
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.name==='node_modules')continue;const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else files.push({path:path.relative(source,full).replaceAll('\\','/'),sha256:hash(full)});}}
walk(source);
const manifest={created_at:new Date().toISOString(),base_commit:head,source,publicationBlocked:true,baselineProductionMatch:'not established; do not replace newer deployed features with HEAD baseline',environment:'no .env files copied; frontend build for verification only',dependencies:'existing node_modules junction; no installation',overlay,files};
fs.writeFileSync(path.join(root,'source-manifest.json'),JSON.stringify(manifest,null,2));
fs.writeFileSync(path.join(output,'latest.json'),JSON.stringify({root,source},null,2));
console.log(JSON.stringify({root,source,files:files.length,base_commit:head}));
