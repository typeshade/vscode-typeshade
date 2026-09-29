// Drives Chromium against a running test-web server (serve.sh): opens a.ts, waits, reads the TypeScript output channel.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const tag = process.argv[2] ?? 'x';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const page = await (
  await browser.newContext({ viewport: { width: 1600, height: 1000 } })
).newPage();
const lines = [];
const rec = (src, t) => {
  if (/probe|plugin|tsserver|TSHADE/i.test(t)) lines.push(`${src} ${t}`);
};
page.on('console', (m) => rec('console', m.text()));
page.on('worker', (w) => {
  rec('worker-created', w.url());
  w.on('console', (m) => rec('worker-console', m.text()));
});
await page.goto('http://localhost:3001');
await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
await page.waitForTimeout(4000);
await page.getByText('a.ts', { exact: true }).first().click();
await page.waitForTimeout(20000);
await page.screenshot({ path: `shot-${tag}-1.png` });
await page.keyboard.press('F1');
await page.waitForTimeout(800);
await page.keyboard.type('Output: Show Output Channels');
await page.waitForTimeout(1200);
await page.screenshot({ path: `shot-${tag}-1b.png` });
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
await page.keyboard.type('TypeScript Server Log');
await page.waitForTimeout(1200);
await page.screenshot({ path: `shot-${tag}-2.png` });
await page.keyboard.press('Enter');
await page.waitForTimeout(2000);
await page.screenshot({ path: `shot-${tag}-3.png` });
await page
  .getByPlaceholder(/Filter/)
  .first()
  .click();
await page.keyboard.type('plugin,Dynamically,Skipped,Couldn,proxy,Failed,Loading');
await page.waitForTimeout(2500);
await page.screenshot({ path: `shot-${tag}-4.png` });
const box = await page.locator('.part.panel .view-lines').first().boundingBox();
await page.mouse.move(box.x + 200, box.y + 40);
await page.mouse.wheel(0, -100000);
await page.waitForTimeout(500);
const seenLines = [];
for (let i = 0; i < 25; i++) {
  const chunk = await page.evaluate(() =>
    [...document.querySelectorAll('.part.panel .view-lines .view-line')].map((e) => e.textContent),
  );
  for (const l of chunk) if (!seenLines.includes(l)) seenLines.push(l);
  await page.mouse.wheel(0, 90);
  await page.waitForTimeout(250);
}
const text = seenLines.join('\n');
writeFileSync(`output-${tag}.txt`, text);
writeFileSync(`console-${tag}.txt`, lines.join('\n'));
console.log('output chars', text.length, 'console lines', lines.length);
await browser.close();
