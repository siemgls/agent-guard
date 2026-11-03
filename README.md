# agent-guard
Drop-in dependency that spots AI agents (Claude in Chrome, Comet, Playwright) on course sites using behavioral signals.

> **agent-guard flags sessions for review. It is not proof of cheating.** Always let a person look at a flagged session before acting on it.

## How it works

```
Browser (quiz page)            Your Express server              agent-guard API
client.js collects   ──────►   agentGuard() middleware  ──────► scores the session
behavior signals               forwards signals + API key ◄──── allow / flag / pause
                               req.agentGuard.check()
```

- **client.js** (3.5 KB) watches how the page is used: automation flags, clicks without mouse movement, text appearing without key presses, typing rhythm, mouse path shape. It sends **counters only**, never keystrokes, answers or mouse coordinates.
- **Middleware** serves the script, forwards the signals to the scoring API, and gives your routes a verdict. The verdict is never sent back to the browser, so an agent can't read its own score.
- If the API is unreachable or the key is invalid, the verdict is `unknown` and nothing is blocked (fail open).

## Usage

```bash
npm install agent-guard
```

```js
import express from 'express';
import { agentGuard } from 'agent-guard';

const app = express();
app.use(agentGuard({ apiKey: process.env.AGENT_GUARD_API_KEY }));

app.post('/quiz/submit', async (req, res) => {
  const { verdict, score, reasons } = await req.agentGuard.check();
  // Save the answers either way. If verdict is 'flag' or 'pause',
  // mark the attempt for teacher review and store `reasons` with it.
});
```

```html
<script src="/agent-guard/client.js"></script>
<script>
  // Optional: make sure the last signals arrive before the form submits
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await window.agentGuard?.flush();
    form.submit();
  });
</script>
```

### Options

| Option | Default | |
|---|---|---|
| `apiKey` | `AGENT_GUARD_API_KEY` env | Your API key |
| `apiUrl` | `AGENT_GUARD_API_URL` env, then `http://localhost:4000` | Scoring API |
| `mountPath` | `/agent-guard` | Where `client.js` and `collect` are served |
| `timeoutMs` | `1500` | Max wait for the API |

### Verdicts

| Verdict | Meaning |
|---|---|
| `allow` | No agent-like signals |
| `flag` | Some agent-like signals: review this attempt |
| `pause` | Strong evidence of automation |
| `unknown` | No data, no key, or API unreachable |

## Development

```bash
npm install
npm run build
AGENT_GUARD_API_KEY=ag_test_... npm run demo   # demo quiz on http://localhost:3000
node test/agent-sim.mjs                        # take the quiz as a Playwright agent
```

## License

MIT
