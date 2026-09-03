import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto('http://127.0.0.1:4173/#hierarchy', { waitUntil: 'networkidle' }); await p.waitForTimeout(800);
const open = () => p.locator('.tip:popover-open, .tip.is-open').count().then(n => n > 0);
const m = p.locator('#panel-hierarchy [data-tip]').nth(3);
await m.focus(); await p.waitForTimeout(150); console.log('focus -> open', await open());
await p.keyboard.press('Escape'); await p.waitForTimeout(150); console.log('Esc (unpinned) -> open', await open(), 'focus still on mark', await p.evaluate(() => !!document.activeElement?.getAttribute('data-tip')));
await m.focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(150); console.log('Enter -> pinned', await p.locator('.tip.is-pinned').count() > 0, 'focus in tip', await p.evaluate(() => !!document.activeElement?.closest('.tip')));
await p.keyboard.press('Escape'); await p.waitForTimeout(200); console.log('Esc #1 -> pinned', await p.locator('.tip.is-pinned').count() > 0, 'open', await open(), 'focus back on mark', await p.evaluate(() => !!document.activeElement?.getAttribute('data-tip')));
await p.keyboard.press('Escape'); await p.waitForTimeout(200); console.log('Esc #2 -> open', await open());
// theme
console.log('theme options', await p.$$eval('#theme option', os => os.map(o => [o.value, o.textContent])));
await p.selectOption('#theme', 'dark'); await p.waitForTimeout(100);
console.log('after pin:', await p.evaluate(() => ({ style: document.documentElement.style.colorScheme, meta: document.querySelector('meta[name=color-scheme]').content, ls: localStorage.getItem('theme'), bg: getComputedStyle(document.body).backgroundColor })));
await p.reload({ waitUntil: 'domcontentloaded' });
console.log('right after reload (inline script):', await p.evaluate(() => ({ style: document.documentElement.style.colorScheme, meta: document.querySelector('meta[name=color-scheme]').content })));
await p.waitForTimeout(500); console.log('select after reload', await p.$eval('#theme', s => s.value));
await p.selectOption('#theme', 'auto'); await p.waitForTimeout(100);
console.log('after reset:', await p.evaluate(() => ({ style: document.documentElement.style.colorScheme, meta: document.querySelector('meta[name=color-scheme]').content, ls: localStorage.getItem('theme') })));
// keyboard-only tab order: Tab from tablist into panel
await p.keyboard.press('Escape');
await b.close();
