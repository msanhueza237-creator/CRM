/// <reference types="node" />
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { publicProductUrl } from '../_shared/market-native-contract.ts';

export function publicIPv4(address:string):boolean {
  if(isIP(address)!==4)return false;
  const [a,b,c]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||
    a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||
    a===203&&b===0&&c===113);
}

// Pin the validated address in the TLS request's lookup. No second DNS resolution,
// redirects, proxy, auth headers or browser state may reach an arbitrary source.
export const publicFetch:typeof fetch=async(input,init={})=>{
  const url=publicProductUrl(String(input));
  const addresses=await Promise.race([
    lookup(url.hostname,{all:true,family:4}),
    new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(new Error('DNS no disponible.')),4000);t.unref?.();}),
  ]);
  if(!addresses.length||addresses.some(a=>!publicIPv4(a.address)))throw new Error('Destino de red no publico.');
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
        resolve(new Response([204,205,304].includes(res.statusCode||200)?null:bytes,{status:res.statusCode||502,headers}));});
    });
    req.setTimeout(12000,()=>req.destroy(new Error('Fuente sin respuesta.')));
    req.on('error',reject);req.end();
  });
};
