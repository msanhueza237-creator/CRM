/// <reference types="node" />
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { Buffer } from 'node:buffer';
import { HTTPParser } from 'http-parser-js';
import { publicProductUrl } from '../_shared/market-native-contract.ts';

export function publicIPv4(address:string):boolean {
  if(isIP(address)!==4)return false;
  const [a,b,c]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||
    a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||
    a===203&&b===0&&c===113);
}

type Connection={read:(b:Uint8Array)=>Promise<number|null>;write:(b:Uint8Array)=>Promise<number>;close:()=>void};
type NativeNetwork={connect:(o:{hostname:string;port:number})=>Promise<Connection>;startTls:(c:Connection,o:{hostname:string;alpnProtocols:string[]})=>Promise<Connection>};
async function decodedResponse(bytes:Uint8Array<ArrayBuffer>,status:number,headers:Headers):Promise<Response>{
  const encoding=(headers.get('content-encoding')||'identity').toLowerCase();
  if(!['identity','gzip','deflate'].includes(encoding))throw new Error('Compresion de fuente no admitida.');
  if(encoding!=='identity'){
    const reader=new Response(bytes).body!.pipeThrough(new DecompressionStream(encoding as 'gzip'|'deflate')).getReader();
    const parts:Uint8Array[]=[];let size=0;
    try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;
      if(size>1500000)throw new Error('Fuente descomprimida demasiado grande.');parts.push(item.value);}}
    finally{await reader.cancel().catch(()=>{});}
    bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    headers.delete('content-encoding');headers.delete('content-length');
  }
  headers.delete('transfer-encoding');return new Response([204,205,304].includes(status)?null:bytes,{status,headers});
}
// Edge's node:https does not implement lookup. TCP pins the validated IP while
// startTls verifies the original hostname. The parser handles HTTP framing.
export async function pinnedNativeResponse(url:URL,address:string,network:NativeNetwork,signal?:AbortSignal|null):Promise<Response>{
  let conn:Connection|undefined,ended=false;
  const close=()=>{ended=true;try{conn?.close();}catch{/* Already closed. */}};
  let timer:ReturnType<typeof setTimeout>|undefined;
  let abort=()=>{};
  const cancelled=new Promise<never>((_,reject)=>{abort=()=>{close();reject(new Error('Fuente sin respuesta o consulta cancelada.'));};timer=setTimeout(abort,12000);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
  const run=async()=>{
    if(ended)throw new Error('Consulta cancelada.');
    conn=await network.connect({hostname:address,port:443});
    if(ended){conn.close();throw new Error('Consulta cancelada.');}
    conn=await network.startTls(conn,{hostname:url.hostname,alpnProtocols:['http/1.1']});
    if(ended){conn.close();throw new Error('Consulta cancelada.');}
    const data=new TextEncoder().encode(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.hostname}\r\nUser-Agent: ClimactivaResearch\r\nAccept: text/html,text/plain\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
    let sent=0;while(sent<data.length){const n=await conn.write(data.subarray(sent));if(n<=0)throw new Error('Conexion incompleta.');sent+=n;}
    const parser=new HTTPParser(HTTPParser.RESPONSE);parser.maxHeaderSize=32768;
    const chunks:Uint8Array[]=[];let status=0,done=false,size=0,wireSize=0;const headers=new Headers();
    parser[HTTPParser.kOnHeadersComplete]=info=>{status=info.statusCode;if(info.upgrade||status===101)throw new Error('Protocolo no admitido.');if(status<200)return;
      for(let i=0;i<info.headers.length;i+=2)headers.append(info.headers[i],info.headers[i+1]);
      if(Number(headers.get('content-length'))>1500000)throw new Error('Fuente demasiado grande.');};
    parser[HTTPParser.kOnBody]=(chunk,offset,length)=>{size+=length;if(size>1500000)throw new Error('Fuente demasiado grande.');chunks.push(Uint8Array.from(chunk.subarray(offset,offset+length)));};
    parser[HTTPParser.kOnMessageComplete]=()=>{if(status>=200)done=true;};
    while(!done){const bytes=new Uint8Array(32768),n=await conn.read(bytes);if(n===null){const error=parser.finish();if(error)throw error;break;}
      wireSize+=n;if(wireSize>1600000)throw new Error('Fuente demasiado grande.');const result=parser.execute(Buffer.from(bytes.subarray(0,n)));if(result instanceof Error)throw result;}
    if(!done||status<200||status>599)throw new Error('Respuesta HTTP incompleta.');
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return decodedResponse(bytes,status,headers);
  };
  try{return await Promise.race([run(),cancelled]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);close();}
}
// No redirects, proxy, auth headers or browser state may reach arbitrary sources.
export const publicFetch:typeof fetch=async(input,init={})=>{
  const url=publicProductUrl(String(input));
  const addresses=await Promise.race([
    lookup(url.hostname,{all:true,family:4}),
    new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(new Error('DNS no disponible.')),4000);t.unref?.();}),
  ]);
  if(!addresses.length||addresses.some(a=>!publicIPv4(a.address)))throw new Error('Destino de red no publico.');
  const native=(globalThis as unknown as {Deno?:NativeNetwork}).Deno;
  if(native)return pinnedNativeResponse(url,addresses[0].address,native,init.signal);
  return new Promise<Response>((resolve,reject)=>{
    const req=request(url,{method:'GET',agent:false,family:4,signal:init.signal||undefined,
      headers:{'User-Agent':'ClimactivaResearch','Accept':'text/html,text/plain','Accept-Encoding':'identity'},
      lookup:((_host:unknown,_options:unknown,cb:(err:null,address:string,family:number)=>void)=>cb(null,addresses[0].address,4)) as never,
    },res=>{
      const chunks:Uint8Array[]=[];let size=0;
      res.on('data',(chunk:Uint8Array)=>{size+=chunk.length;if(size>1500000){req.destroy(new Error('Fuente demasiado grande.'));return;}chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>{const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
        const headers=new Headers();for(const [k,v] of Object.entries(res.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(', '):String(v));
        decodedResponse(bytes,res.statusCode||502,headers).then(resolve,reject);});
    });
    req.setTimeout(12000,()=>req.destroy(new Error('Fuente sin respuesta.')));
    req.on('error',reject);req.end();
  });
};
