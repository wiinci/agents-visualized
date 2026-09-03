// QA pass for the built app: six views render with NO tooltip system anywhere
// (no .tip element, no [data-tip] attributes — the Sankey info panel is the only
// node-detail surface, swapped by hover/focus), the panel renders at 24rem beside
// the chart from the 900px container breakpoint and stacks below it, and
// screenshots are saved for every view in both themes.
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

// Tooltip removal is total: never a .tip element, never a [data-tip] attribute.
const tooltipAbsent = () => page.evaluate(() => ({
  tipElements: document.querySelectorAll('.tip, .tip-anchor').length,
  tipAttributes: document.querySelectorAll('[data-tip]').length,
  openPopovers: document.querySelectorAll(':popover-open').length,
}));

const tabs = await page.$$('#tablist [role=tab]');
const views = [];
for (const tab of tabs) {
  const id = await tab.getAttribute('data-view');
  await tab.click();
  await page.waitForTimeout(600);
  const panel = page.locator(`#panel-${id}`);
  const svgCount = await panel.locator('svg').count();
  const tableCount = await panel.locator('table').count();
  const renderErrors = await panel.locator('.error').count();
  const tipMarks = await panel.locator('[data-tip]').count(); // must stay 0 on every view
  const hitMarks = await panel.locator('[data-hit]').count(); // interaction hooks (informational)
  const tipState = await tooltipAbsent();
  if (tipMarks > 0) errors.push(`${id}: ${tipMarks} [data-tip] attributes found — tooltip system must be gone`);
  if (tipState.tipElements > 0) errors.push(`${id}: ${tipState.tipElements} tooltip element(s) found in the document`);
  await page.screenshot({ path: `${out}/${id}.png` });
  views.push({ view: id, svgCount, tableCount, tipMarks, hitMarks, renderErrors });
}

// Sankey info panel: a permanent column beside the chart, 24rem wide from the
// 900px container breakpoint (stacked below it). Default = the origin (source)
// node; hovering or focusing a node swaps the content; mouseout/blur reverts.
// Captures the hovered state (light) and the default state (dark).
await page.selectOption('#theme', 'auto'); await page.waitForTimeout(300);
await page.click('#tab-sankey'); await page.waitForTimeout(600);
const sPanel = page.locator('#panel-sankey .sankey-panel');
const sPanelInfo = { present: (await sPanel.count()) === 1 };
if (!sPanelInfo.present) {
  errors.push('sankey: info panel missing');
} else {
  sPanelInfo.ariaLive = await sPanel.getAttribute('aria-live');
  sPanelInfo.visible = await sPanel.isVisible();
  const layout = page.locator('#panel-sankey .sankey-layout');
  const tracks = (await layout.evaluate((n) => getComputedStyle(n).gridTemplateColumns)).trim().split(/\s+/);
  sPanelInfo.besideChart = tracks.length >= 2;
  if (sPanelInfo.ariaLive !== 'polite') errors.push('sankey: info panel aria-live is not polite');
  if (!sPanelInfo.visible) errors.push('sankey: info panel is not visible by default');
  if (!sPanelInfo.besideChart) errors.push(`sankey: info panel is not beside the chart (grid tracks: ${tracks.join(' | ')})`);
  // Width: the panel column must resolve to 24rem (±2px) at ≥900px container width.
  const width = await layout.evaluate((n) => {
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const cols = getComputedStyle(n).gridTemplateColumns.trim().split(/\s+/);
    return { track: parseFloat(cols[cols.length - 1]), expected: 24 * root };
  });
  sPanelInfo.panelTrackPx = width.track;
  sPanelInfo.expectedPx = width.expected;
  if (Math.abs(width.track - width.expected) > 2) errors.push(`sankey: panel column is ${width.track}px, expected 24rem ≈ ${width.expected}px`);
  const sTitle = sPanel.locator('.sankey-panel-body .sankey-panel-title');
  const defaultTitle = ((await sTitle.textContent()) ?? '').trim();
  sPanelInfo.defaultNode = defaultTitle;
  if (!defaultTitle) errors.push('sankey: info panel has no default (origin) content');
  const sNodes = page.locator('#panel-sankey .sankey-node');
  let target = null; let targetStage = '';
  for (let i = 0, n = await sNodes.count(); i < n; i++) {
    const nd = sNodes.nth(i);
    const stage = (((await nd.getAttribute('aria-label')) ?? '').split(',')[0] ?? '').trim();
    if (stage && stage !== defaultTitle) { target = nd; targetStage = stage; break; }
  }
  if (!target) {
    errors.push('sankey: no node with a stage different from the default panel content to hover');
  } else {
    await target.locator('.sankey-hit').hover({ force: true });
    await page.waitForTimeout(250);
    const hoverTitle = ((await sTitle.textContent()) ?? '').trim();
    const tipAfterHover = await tooltipAbsent();
    sPanelInfo.hoverNode = hoverTitle;
    sPanelInfo.noTooltipOnHover = tipAfterHover.tipElements === 0 && tipAfterHover.tipAttributes === 0;
    if (hoverTitle !== targetStage) errors.push(`sankey: hovering a node left the panel at "${hoverTitle}", expected "${targetStage}"`);
    if (!sPanelInfo.noTooltipOnHover) errors.push(`sankey: tooltip elements/attributes appeared on hover (elements: ${tipAfterHover.tipElements}, attributes: ${tipAfterHover.tipAttributes})`);
    await page.screenshot({ path: `${out}/sankey-panel.png` });
    await page.mouse.move(5, 5); await page.waitForTimeout(300);
    const revertTitle = ((await sTitle.textContent()) ?? '').trim();
    sPanelInfo.revertsOnMouseout = revertTitle === defaultTitle;
    if (revertTitle !== defaultTitle) errors.push(`sankey: mouse-out left the panel at "${revertTitle}", expected default "${defaultTitle}"`);
    await target.focus(); await page.waitForTimeout(250);
    const focusTitle = ((await sTitle.textContent()) ?? '').trim();
    sPanelInfo.focusNode = focusTitle;
    if (focusTitle !== targetStage) errors.push(`sankey: focusing a node left the panel at "${focusTitle}", expected "${targetStage}"`);
    await page.click('#tab-sankey'); await page.waitForTimeout(200); // blur the node → panel reverts
  }

  // Stacked layout below the 900px breakpoint: panel drops under the chart (one track).
  await page.setViewportSize({ width: 820, height: 800 }); await page.waitForTimeout(500);
  const stackedTracks = (await layout.evaluate((n) => getComputedStyle(n).gridTemplateColumns)).trim().split(/\s+/);
  sPanelInfo.stackedBelowBreakpoint = stackedTracks.length === 1;
  if (!sPanelInfo.stackedBelowBreakpoint) errors.push(`sankey: layout should stack below the 900px breakpoint (tracks: ${stackedTracks.join(' | ')})`);
  await page.screenshot({ path: `${out}/sankey-panel-stacked.png` });
  await page.setViewportSize({ width: 1400, height: 900 }); await page.waitForTimeout(500);

  await page.selectOption('#theme', 'dark'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/sankey-panel-dark.png` });
  const tipStateDark = await tooltipAbsent();
  if (tipStateDark.tipElements > 0 || tipStateDark.tipAttributes > 0) errors.push(`sankey: tooltip found in dark mode (elements: ${tipStateDark.tipElements}, attributes: ${tipStateDark.tipAttributes})`);
}

// Extra screenshots: dark mode across views
await page.selectOption('#theme', 'dark'); await page.waitForTimeout(200);
await page.click('#tab-hierarchy'); await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/hierarchy-dark.png` });
await page.click('#tab-sankey'); await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/sankey-dark.png` });
await page.setViewportSize({ width: 420, height: 800 }); await page.waitForTimeout(500);
await page.click('#tab-context'); await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/context-narrow-dark.png` });

const result = { base, banner: { hidden: bannerHidden, text: bannerText.slice(0, 200) }, source: sourceText.slice(0, 200), data: dataUrl, views, sankeyPanel: sPanelInfo, errors };
writeFileSync(`${out}/qa-result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ banner: result.banner, data: dataUrl }, null, 2));
console.table(views);
console.log('sankey panel:', JSON.stringify(sPanelInfo, null, 2));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
