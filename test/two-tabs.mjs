// A submit in one tab clears the session cookie. A quiz already open in another
// tab must still get a verdict. Start agent-guard-api and the demo quiz first.
import { chromium } from 'playwright';

const QUIZ_URL = process.env.QUIZ_URL ?? 'http://localhost:3000/';

const browser = await chromium.launch();
const context = await browser.newContext();
const [tabA, tabB] = [await context.newPage(), await context.newPage()];

await tabA.goto(QUIZ_URL);
await tabB.goto(QUIZ_URL);

await Promise.all([tabB.waitForURL('**/quiz/submit'), tabB.click('button[type=submit]')]);
await Promise.all([tabA.waitForURL('**/quiz/submit'), tabA.click('button[type=submit]')]);

const verdict = await tabA.locator('strong').innerText();
await browser.close();

console.log(`Tab A verdict after tab B submitted: ${verdict}`);
if (verdict === 'unknown') process.exit(1);
