import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium } from "playwright";

// Isolated component test: no authentication, CRM requests or real documents.
const output = process.env.FACTO_POSTING_UI_OUTPUT || join(tmpdir(), "crm-facto-posting-ui");
await mkdir(output, { recursive: true });
const bundled = await build({
  stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {FactoPostingReview} from './src/modules/accounting/FactoPostingReview';
    createRoot(document.getElementById('root')).render(<main className="accounting-center-page" style={{padding:12,maxWidth:960,margin:'auto'}}>
      <FactoPostingReview entityId="entity" source={{id:'doc',source_type:'FACTO',document_type:'sales_invoice',folio:'TEST',counterpart_name:'Empresa de prueba'}}
        onPosted={async()=>{window.calls.push('refresh');if(window.mode==='refresh-failure')throw new Error('refresh failed')}} />
    </main>);
  ` },
  bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "mock-accounting-api", setup(b) {
    b.onLoad({ filter: /[/\\]accountingApi\.ts$/ }, () => ({ loader: "js", contents: `
      export async function previewFactoPosting(entityId,id){
        window.calls.push({type:'preview',entityId,id});
        if(window.mode==='preview-failure')throw new Error('Periodo cerrado');
        return {preview:window.preview,bankBalanceAdjustments:0};
      }
      export async function confirmFactoPosting(entityId,preview){
        window.calls.push({type:'post',entityId,preview});
        if(window.mode==='post-failure')throw new Error('No se pudo verificar el resultado');
        return {documents:[{id:'doc',folio:'TEST'}],bankBalanceAdjustments:0};
      }
    ` }));
  } }],
});
const css = await readFile(resolve("src/styles.css"), "utf8") + "\n" + await readFile(resolve("src/modules/accounting/accountingCenter.css"), "utf8");
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const errors = [];
try {
  const context = await browser.newContext();
  await context.route("**/*", route => route.abort());
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  async function mount(mode = "success") {
    await page.goto("about:blank");
    await page.setContent('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div></body></html>');
    await page.addStyleTag({ content: css });
    await page.evaluate(mode => {
      window.mode = mode; window.calls = [];
      window.preview = { id: "doc", folio: "TEST", date: "2026-09-27", type: "sales_invoice", net: 99840, tax: 18970, total: 118810, creditNote: false, reviewKey: "review-fixture" };
    }, mode);
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    await page.getByRole("button", { name: "Revisar asiento" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls), []);
  }
  await mount();
  await page.getByRole("button", { name: "Revisar asiento" }).click();
  const post = page.getByRole("button", { name: "Contabilizar documento" });
  await post.waitFor(); assert.equal(await post.isDisabled(), true);
  assert.equal((await page.evaluate(() => window.calls)).length, 1);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow at ${width}`);
    assert.match(await page.getByRole("table").innerText(), /99\.840/);
    assert.equal(await page.locator("td, th").evaluateAll(cells => cells.every(cell => {
      const rect = cell.getBoundingClientRect();
      return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth;
    })), true, `all amounts visible at ${width}`);
    await page.screenshot({ path: join(output, `preview-${width}.png`), fullPage: true });
  }
  await page.getByRole("checkbox").check();
  await post.click(); await page.getByRole("status").waitFor();
  const calls = await page.evaluate(() => window.calls);
  assert.equal(calls.filter(c => c.type === "post").length, 1);
  assert.equal(calls[1].preview.reviewKey, "review-fixture");
  assert.equal(calls[2], "refresh");
  assert.equal(await post.count(), 0);

  await mount("preview-failure");
  await page.getByRole("button", { name: "Revisar asiento" }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(await post.count(), 0);
  for (const mode of ["post-failure", "refresh-failure"]) {
    await mount(mode);
    await page.getByRole("button", { name: "Revisar asiento" }).click();
    await page.getByRole("checkbox").check(); await post.click();
    await page.getByRole("alert").waitFor();
    if (mode === "post-failure") assert.equal(await post.isDisabled(), true);
    else { assert.equal(await page.getByRole("status").count(), 1); assert.equal(await post.count(), 0); }
    assert.equal((await page.evaluate(() => window.calls)).filter(c => c.type === "post").length, 1);
  }
  assert.deepEqual(errors, []);
  console.log(`Facto posting UI: preview, explicit confirmation, saved values, error recovery and 1280/390/320 layouts passed. Screenshots: ${output}`);
} finally { await browser.close(); }
