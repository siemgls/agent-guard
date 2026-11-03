// Demo course site using agent-guard.
// Run the scoring API first (agent-guard-api: npm run dev), then:
//   AGENT_GUARD_API_KEY=ag_test_... npm run demo
import express from 'express';
import { fileURLToPath } from 'node:url';
import { agentGuard } from '../../dist/server/index.js';

const app = express();

// 1. Serves /agent-guard/client.js, receives signals, adds req.agentGuard
app.use(agentGuard());

app.use(express.urlencoded({ extended: false }));
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

// 2. Check the session when the quiz is submitted
app.post('/quiz/submit', async (req, res) => {
  const result = await req.agentGuard.check();

  // A real site would save the answers either way and show `result` to the
  // teacher only, never to the student. Shown here so you can see it work.
  const color = { allow: '#1a7f37', flag: '#9a6700', pause: '#cf222e', unknown: '#57606a' }[result.verdict];
  res.send(`<!doctype html><meta charset="utf-8"><title>Result</title>
    <body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px">
    <h1>Quiz submitted</h1>
    <p>agent-guard verdict: <strong style="color:${color}">${result.verdict}</strong> (score ${result.score})</p>
    <ul>${result.reasons.map((r) => `<li>${r.replace(/</g, '&lt;')}</li>`).join('') || '<li>No agent-like signals.</li>'}</ul>
    <p><a href="/">Take it again</a></p></body>`);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Demo quiz on http://localhost:${port}`));
