import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const protocol=new URL('../src/modules/copilot/geminiProtocol.ts',import.meta.url).href;
const source=fs.readFileSync(new URL('../src/modules/copilot/geminiTransport.ts',import.meta.url),'utf8')
  .replace('import captureUrl from "./geminiCapture.worklet.js?url";', 'const captureUrl="fixture-worklet";')
  .replace('"./geminiProtocol"',JSON.stringify(protocol));
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {GeminiTransport}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));

function fixture() {
  const original={WebSocket:globalThis.WebSocket,AudioWorkletNode:globalThis.AudioWorkletNode};
  const nodes=[],events=[];
  class Node {
    port={onmessage:null,close:()=>{this.portClosed=true;}};
    connect(){return this;} disconnect(){this.disconnected=true;}
    start(){this.started=true;}stop(){this.stopped=true;}
  }
  let socket;
  class Socket {
    static OPEN=1;readyState=1;bufferedAmount=0;sent=[];
    constructor(){socket=this;queueMicrotask(()=>this.onopen?.());}
    send(data){this.sent.push(JSON.parse(data));} close(){this.readyState=3;this.onclose?.({code:1000});}
    receive(data){this.onmessage?.({data:JSON.stringify(data)});}
  }
  globalThis.WebSocket=Socket; globalThis.AudioWorkletNode=Node;
  const context={currentTime:1,sampleRate:48000,state:'running',destination:{},
    audioWorklet:{addModule:async()=>{}}, createMediaStreamSource:()=>new Node(),
    createGain:()=>Object.assign(new Node(),{gain:{value:1}}),
    createBuffer:(_channels,length,rate)=>({duration:length/rate,getChannelData:()=>new Float32Array(length)}),
    createBufferSource:()=>{const n=new Node();nodes.push(n);return n;},
  };
  const transport=new GeminiTransport(context,e=>events.push(e));
  const session={credential:'auth_tokens/fixture',model:'fixture-live',history:[]};
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  return {transport,session,nodes,events,tick,get socket(){return socket;},
    restore(){transport.close();Object.assign(globalThis,original);},
    async start(){const pending=transport.start(session,{},new AbortController().signal);await tick();socket.receive({setupComplete:{}});await pending;},
  };
}

test('Gemini transport completes setup, queues PCM, and clears all output on barge-in',async()=>{
  const f=fixture();try{
    await f.start();assert.deepEqual(f.socket.sent[0],{setup:{model:'models/fixture-live'}});
    f.socket.receive({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm',data:'AAA='}}]}}});
    await f.tick();assert.equal(f.nodes.length,1);assert.equal(f.nodes[0].started,true);
    f.socket.receive({serverContent:{interrupted:true}});await f.tick();
    assert.equal(f.nodes[0].stopped,true);assert.ok(f.events.some(e=>e.type==='voice.interrupted'));
  }finally{f.restore();}
});

test('Closing while connecting releases startup and does not request a reconnect',async()=>{
  const f=fixture();try{
    const controller=new AbortController();
    const pending=f.transport.start(f.session,{},controller.signal);
    const rejected=assert.rejects(pending,e=>e.name==='AbortError');
    await f.tick();controller.abort();await rejected;
    assert.equal(f.socket.readyState,3);assert.ok(!f.events.some(e=>e.type==='voice.reconnect'));
  }finally{f.restore();}
});

test('Mute ends the input stream; network close signals bounded hook reconnection',async()=>{
  const f=fixture();try{
    await f.start();f.transport.mute(true);
    assert.deepEqual(f.socket.sent.at(-1),{realtimeInput:{audioStreamEnd:true}});
    f.socket.close();assert.ok(f.events.some(e=>e.type==='voice.reconnect'));
  }finally{f.restore();}
});

test('Manual stop suppresses stale audio and resumes only after new user transcription',async()=>{
  const f=fixture();try{
    await f.start();f.transport.interrupt();
    const audio={modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm',data:'AAA='}}]}};
    f.socket.receive({serverContent:audio});await f.tick();assert.equal(f.nodes.length,0);
    f.socket.receive({serverContent:{inputTranscription:{text:'Nueva pregunta'}}});
    f.socket.receive({serverContent:audio});await f.tick();assert.equal(f.nodes.length,1);
  }finally{f.restore();}
});
