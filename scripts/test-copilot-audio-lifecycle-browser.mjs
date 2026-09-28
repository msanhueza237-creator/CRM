import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Real React hook/panel/transport, with no microphone, credentials, or CRM data.
const server = await createServer({ server: { host: '127.0.0.1', port: 0, open: false }, optimizeDeps: { include: ['react', 'react-dom/client'] } });
let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined) });
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript(() => {
    window.__voiceTest = { requests: 0, completions: 0, speech: 0, hidden: false };
    const test = window.__voiceTest;
    Object.defineProperty(document, 'visibilityState', { get: () => test.hidden ? 'hidden' : 'visible' });
    class Track extends EventTarget { enabled = true; muted = false; stop() { this.stopped = true; } }
    const track = new Track();
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) });
    class Node {
      port = { onmessage: null, close() {} };
      connect() { return this; } disconnect() {} stop() {}
      start() { test.speech++; setTimeout(() => this.onended?.(), 50); }
    }
    window.AudioWorkletNode = class extends Node { constructor() { super(); test.capture = this; } };
    window.AudioContext = class extends EventTarget {
      state = 'running'; sampleRate = 48000; currentTime = 0; destination = {};
      audioWorklet = { addModule: async () => {} };
      constructor() { super(); test.context = this; }
      resume() { this.state = 'running'; this.dispatchEvent(new Event('statechange')); return Promise.resolve(); }
      close() { this.state = 'closed'; return Promise.resolve(); }
      createMediaStreamSource() { return new Node(); }
      createGain() { return Object.assign(new Node(), { gain: { value: 0 } }); }
      createBuffer(_channels, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
      createBufferSource() { return new Node(); }
    };
    window.WebSocket = class {
      static OPEN = 1; readyState = 1; bufferedAmount = 0;
      constructor() { test.socket = this; setTimeout(() => this.onopen?.(), 0); }
      send(data) { const e = JSON.parse(data); if (e.setup) this.receive({ setupComplete: {} }); }
      receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
      close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    };
    test.suspend = () => {
      test.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
      test.context.state = 'suspended'; test.context.dispatchEvent(new Event('statechange'));
    };
    test.unlock = () => { test.hidden = false; document.dispatchEvent(new Event('visibilitychange')); };
    test.audio = () => test.socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: 'AAA=' } }] } } });
    setInterval(() => {
      if (test.context?.state === 'running' && !track.stopped) test.capture?.port.onmessage?.({ data: new Float32Array(2048) });
    }, 50);
  });
  await page.route('**/src/lib/copilotCentralApi.ts', route => route.fulfill({ contentType: 'text/javascript', body: `
    export async function copilotVoiceRequest(route) {
      if(route==='voice-session') return {voiceSessionId:'fixture-session',conversationId:'fixture-conversation',protocol:'gemini',credential:'auth_tokens/fixture',model:'fixture-model',history:[],maxSeconds:900};
      if(route==='voice-result') return {spokenResult:'Resultado de prueba guardado'};
      return {};
    }
    export async function streamCentralMessage(question,conversation,signal,emit) {
      window.__voiceTest.requests++;
      emit({type:'tool_start'});
      await new Promise(resolve=>{window.__voiceTest.finishQuery=resolve});
      if(signal.aborted) throw new DOMException('Cancelado','AbortError');
      emit({type:'complete',messageId:'fixture-message',message:'Resultado de prueba guardado'});
    }
  ` }));
  const html = await server.transformIndexHtml('/__voice_audio_test', `
    <html><head></head><body><div id="root"></div><script type="module">
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import {useCopilotLive} from '/src/modules/copilot/useCopilotLive.ts';
    import {CopilotLivePanel} from '/src/modules/copilot/CopilotLivePanel.tsx';
    import '/src/modules/copilot/central-copilot.css';
    function Test(){
      const live=useCopilotLive('fixture-conversation',{
        onEvent:e=>{if(e.type==='complete')window.__voiceTest.completions++},
        onQuestion:()=>{},onBusy:()=>{},onError:()=>{},
      },'fixture-deepseek','gemini');
      return React.createElement(CopilotLivePanel,{live,onText:()=>{}});
    }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Test));
    </script></body></html>`);
  await page.route('**/__voice_audio_test', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`http://127.0.0.1:${port}/__voice_audio_test`);
  await page.getByRole('button', { name: 'Conectar voz', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Escuchando' }).waitFor();
  await page.evaluate(() => window.__voiceTest.socket.receive({ toolCall: { functionCalls: [{ id: 'fixture-call', name: 'ask_manager', args: { question: 'Consulta de prueba' } }] } }));
  await page.getByRole('status').filter({ hasText: 'Consultando CRM' }).waitFor();
  await page.evaluate(() => window.__voiceTest.suspend());
  await page.getByRole('status').filter({ hasText: 'Audio suspendido' }).waitFor();
  await page.getByRole('button', { name: 'Reanudar audio', exact: true }).waitFor();
  await page.evaluate(() => window.__voiceTest.finishQuery());
  await page.waitForFunction(() => window.__voiceTest.completions === 1);
  await page.evaluate(() => window.__voiceTest.audio());
  await page.waitForFunction(() => window.__voiceTest.context.state === 'suspended');
  assert.equal(await page.evaluate(() => window.__voiceTest.speech), 0);
  await page.evaluate(() => window.__voiceTest.unlock());
  await page.getByRole('status').filter({ hasText: 'Escuchando' }).waitFor();
  assert.equal(await page.evaluate(() => window.__voiceTest.requests), 1);
  await page.evaluate(() => window.__voiceTest.audio());
  await page.waitForFunction(() => window.__voiceTest.speech === 1);
  await page.getByRole('button', { name: 'Finalizar voz', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Desconectado' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: mobile React voice UI detects suspension, retains CRM completion, resumes without duplicate query, and stops cleanly. Simulated audio only.');
} finally {
  await browser?.close();
  await server.close();
}
