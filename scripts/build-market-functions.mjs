import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root='outputs/market-extraction/bundles',manifest={localOnly:true,files:[]};await mkdir(root,{recursive:true});
for(const name of ['market-study','market-research']){
 const outfile=`${root}/${name}/index.ts`;
 const result=await build({entryPoints:[`supabase/functions/${name}/index.ts`],bundle:true,format:'esm',platform:'neutral',target:'es2022',external:['node:*'],outfile,metafile:true});
 const bytes=await readFile(outfile);manifest.files.push({path:outfile,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),inputs:Object.keys(result.metafile.inputs)});
}
await writeFile(`${root}/manifest.json`,JSON.stringify(manifest,null,2));console.log('PASS two local standalone Edge bundles; no deployment');
