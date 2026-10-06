import {publicFetch} from '../supabase/functions/market-study/public-network.ts';
// Read-only smoke test under Deno, not Node's HTTPS compatibility path.
const response=await publicFetch('https://example.com/',{signal:AbortSignal.timeout(15000)});
if(response.status!==200||!(await response.text()).includes('Example Domain'))throw new Error('Public TLS probe failed');
for(const url of ['https://expired.badssl.com/','https://wrong.host.badssl.com/']){
 let rejected=false;try{await publicFetch(url,{signal:AbortSignal.timeout(15000)});}catch{rejected=true;}
 if(!rejected)throw new Error('Invalid TLS certificate accepted');
}
console.log('PASS native pinned TLS: public response and invalid certificates rejected');
