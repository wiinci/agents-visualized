// QA pass for the built app: six views render, tooltips open on hover + focus,
// tooltip rows carry size / context / prompt fields per node kind, screenshots saved.
// Usage: node qa.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:4173/';
const out = process.argv[3] ?? new URL('.', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`); });

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForSelector('#tablist [role=tab]');
await page.waitForTimeout(800);

const bannerHidden = await page.$eval('#banner', (b) => b.hidden);
const bannerText = ((await page.textContent('#banner')) ?? '').trim();
const sourceText = ((await page.textContent('#source-text').catch(() => '')) ?? '').trim();
const dataUrl = await page.evaluate(async () => {
  const r = await fetch('./data/loops.json'); const j = await r.json();
  return { status: r.status, generatedAt: j.generatedAt, threads: j.source.threadIds.length, messages: j.source.messageCount };
});

const tipOpen = () => page.locator('.tip:popover-open, .tip.is-open').count().then((n) => n > 0);
const readTip = () => page.evaluate(() => {
  const tip = document.querySelector('.tip'); if (!tip) return null;
  const rows = {};
  const dl = tip.querySelector('.tip-rows');
  if (dl) { const dts = [...dl.querySelectorAll('dt')]; const dds = [...dl.querySelectorAll('dd')]; dts.forEach((dt, i) => { rows[dt.textContent.trim()] = dds[i]?.textContent.trim() ?? ''; }); }
  return { title: tip.querySelector('.tip-title')?.textContent.trim() ?? '', rows, textLen: tip.querySelector('.tip-text')?.textContent.length ?? 0 };
});

const tabs = await page.$$('#tablist [role=tab]');
const views = [];
for (const tab of tabs) {
  const id = await tab.getAttribute('data-view');
  await tab.click();
  await page.waitForTimeout(600);
  const panel = page.locator(`#panel-${id}`);
  const svgCount = await panel.locator('svg').count();
  const tableCount = await panel.locator('table').count();
  const tipTargets = await panel.locator('[data-tip]').count();
  const renderErrors = await panel.locator('.error').count();
  let hoverTipOpen = false, focusTipOpen = false, arrowMoved = false, pinOpen = false, escClosed = false;
  if (tipTargets) {
    const first = panel.locator('[data-tip]').first();
    await first.scrollIntoViewIfNeeded();
    await first.hover({ force: true }); await page.waitForTimeout(200);
    hoverTipOpen = await tipOpen();
    await page.mouse.move(5, 5); await page.waitForTimeout(300);
    await first.focus(); await page.waitForTimeout(200);
    focusTipOpen = await tipOpen();
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(150);
    arrowMoved = !!(await page.evaluate(() => document.activeElement?.getAttribute('data-tip')));
    await page.keyboard.press('Enter'); await page.waitForTimeout(150);
    pinOpen = await page.locator('.tip.is-pinned').count() > 0;
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    escClosed = !(await tipOpen());
    await page.mouse.move(5, 5); await page.waitForTimeout(200);
  }
  await page.screenshot({ path: `${out}/${id}.png` });
  views.push({ view: id, svgCount, tableCount, tipTargets, renderErrors, hoverTipOpen, focusTipOpen, arrowMoved, pinOpen, escClosed });
}

// Tooltip field audit: hover marks across the views, group by tooltip "kind" row.
const kinds = {};
const audit = async (viewId, max) => {
  await page.click(`#tab-${viewId}`); await page.waitForTimeout(500);
  const marks = page.locator(`#panel-${viewId} [data-tip]`);
  const n = Math.min(await marks.count(), max);
  for (let i = 0; i < n; i++) {
    const m = marks.nth(i);
    await m.focus().catch(() => {}); await page.waitForTimeout(40);
    if (!(await tipOpen())) continue;
    const t = await readTip(); if (!t) continue;
    const kind = t.rows.kind ?? `(${viewId}:${await m.getAttribute('data-tip')})`;
    const k = (kinds[kind] ??= { seen: 0, size: 0, context: 0, prompt: 0, text: 0, sampleTitle: t.title, sampleRows: t.rows });
    k.seen++;
    if (t.rows.size && /chars/.test(t.rows.size) && /tokens \(est\.\)/.test(t.rows.size)) k.size++;
    if (t.rows['context at this point']) k.context++;
    if (t.rows['prompt size']) k.prompt++;
    if (t.textLen > 0) k.text++;
  }
  await page.keyboard.press('Escape'); await page.mouse.move(5, 5);
};
await audit('hierarchy', 400);
await audit('delegation', 40);
await audit('sankey', 80);
await audit('context', 120);
await audit('loops', 80);
await audit('summary', 20);

// Extra screenshots: pinned tooltip, dark mode
await page.click('#tab-hierarchy'); await page.waitForTimeout(400);
const cell = page.locator('#panel-hierarchy [data-tip]').nth(5);
await cell.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(250);
await page.screenshot({ path: `${out}/hierarchy-pinned-tooltip.png` });
await page.keyboard.press('Escape');
await page.selectOption('#theme', 'dark'); await page.waitForTimeout(200);
await page.click('#tab-sankey'); await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/sankey-dark.png` });
await page.setViewportSize({ width: 420, height: 800 }); await page.waitForTimeout(500);
await page.click('#tab-context'); await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/context-narrow-dark.png` });

const result = { base, banner: { hidden: bannerHidden, text: bannerText.slice(0, 200) }, source: sourceText.slice(0, 200), data: dataUrl, views, tooltipKinds: kinds, errors };
writeFileSync(`${out}/qa-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ banner: result.banner, data: dataUrl }, null, 2));
console.table(views);
console.table(Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, { seen: v.seen, size: v.size, context: v.context, prompt: v.prompt, text: v.text }])));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.filter((e) => e.startsWith('pageerror')).length ? 1 : 0);
