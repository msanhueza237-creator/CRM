import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pinnedNativeResponse} from '../supabase/functions/market-study/public-network.ts';
const url=new URL('https://tienda.cl/producto');
function fixture(response,step=7){let cursor=0,closed=0,request='',dial,tls;const bytes=new TextEncoder().encode(response),conn={async read(b){if(cursor>=bytes.length)return null;const n=Math.min(b.length,step,bytes.length-cursor);b.set(bytes.subarray(cursor,cursor+n));cursor+=n;return n;},async write(b){request+=new TextDecoder().decode(b);return b.length;},close(){closed++;}};return {network:{async connect(o){dial=o;return conn;},async startTls(c,o){assert.equal(c,conn);tls=o;return conn;}},inspect:()=>({closed,request,dial,tls})};}
test('Deno transport pins IPv4, TLS hostname and HTTP host separately; chunked body parsed',async()=>{
 const f=fixture('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nhola\r\n0\r\n\r\n');
 const r=await pinnedNativeResponse(url,'8.8.8.8',f.network);assert.equal(await r.text(),'hola');assert.deepEqual(f.inspect().dial,{hostname:'8.8.8.8',port:443});assert.equal(f.inspect().tls.hostname,'tienda.cl');assert.match(f.inspect().request,/Host: tienda.cl/);assert.doesNotMatch(f.inspect().request,/cookie|authorization/i);assert.ok(f.inspect().closed>0);
});
test('Incomplete, oversized, invalid and aborted responses are never accepted',async()=>{
 for(const response of ['HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nx','HTTP/1.1 200 OK\r\nContent-Length: 9999999\r\n\r\n','not http\r\n\r\n']){const f=fixture(response);await assert.rejects(pinnedNativeResponse(url,'8.8.8.8',f.network));assert.ok(f.inspect().closed);}
 const f=fixture('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');await assert.rejects(pinnedNativeResponse(url,'8.8.8.8',f.network,AbortSignal.abort()));assert.equal(f.inspect().dial,undefined);
});
test('Redirect is returned without following it; TLS failure closes TCP',async()=>{
 const f=fixture('HTTP/1.1 302 Found\r\nLocation: https://internal/\r\nContent-Length: 0\r\n\r\n');assert.equal((await pinnedNativeResponse(url,'8.8.8.8',f.network)).status,302);
 const bad=fixture('');bad.network.startTls=async()=>{throw Error('certificate mismatch');};await assert.rejects(pinnedNativeResponse(url,'8.8.8.8',bad.network),/certificate/);assert.ok(bad.inspect().closed);
});
