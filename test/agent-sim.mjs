// Takes the demo quiz as an automated agent and prints agent-guard's verdict.
// Start agent-guard-api and the demo quiz first, then: node test/agent-sim.mjs
import { chromium } from 'playwright';

const QUIZ_URL = process.env.QUIZ_URL ?? 'http://localhost:3000/';

async function runAgent(name, launchOptions, actions) {
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  await page.goto(QUIZ_URL);
  await actions(page);
  await Promise.all([page.waitForURL('**/quiz/submit'), page.click('button[type=submit]')]);
  const verdict = await page.locator('strong').innerText();
  const reasons = await page.locator('li').allInnerTexts();
  await browser.close();
  console.log(`\n${name}: ${verdict}`);
  for (const r of reasons) console.log(`  - ${r}`);
}

// 1. Naive agent: default Playwright, fills fields directly (like most agents' "type" tool).
await runAgent('Naive agent', {}, async (page) => {
  await page.fill('#name', 'Alex');
  await page.check('input[value=mercury]');
  await page.check('input[value="8m"]');
  await page.fill('#q3', 'The Moon reflects sunlight and we see different parts of the lit half as it orbits Earth.');
});

// Inserts text straight into fields with no key events, in several chunks.
await runAgent('Insert-text agent', {}, async (page) => {
  await page.click('#name');
  await page.keyboard.insertText('Alex');
  await page.check('input[value=mercury]');
  await page.check('input[value="8m"]');
  await page.click('#q3');
  for (const part of ['The Moon reflects sunlight. ', 'We see different parts ', 'of the lit half. ', 'It orbits Earth.']) {
    await page.keyboard.insertText(part);
    await page.waitForTimeout(150);
  }
});

// 2. Stealthier agent: hides navigator.webdriver, types key by key, moves the mouse first.
await runAgent(
  'Stealthy agent',
  { args: ['--disable-blink-features=AutomationControlled'] },
  async (page) => {
    await page.click('#name');
    await page.keyboard.type('Alex', { delay: 80 });
    for (const sel of ['input[value=mercury]', 'input[value="8m"]', '#q3']) {
      const box = await page.locator(sel).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 });
      await page.mouse.down();
      await page.mouse.up();
    }
    await page.keyboard.type('The Moon reflects sunlight and we see different parts of the lit half.', { delay: 60 });
  },
);
