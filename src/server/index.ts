import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { ScoreResult, SignalBatch, Verdict } from '../shared/types.js';

export type { ScoreResult, SignalBatch, Verdict } from '../shared/types.js';

export interface AgentGuardOptions {
  /** Your agent-guard API key (ag_live_... or ag_test_...). Defaults to AGENT_GUARD_API_KEY. */
  apiKey?: string;
  /** Scoring API base URL. Defaults to AGENT_GUARD_API_URL, then http://localhost:4000. */
  apiUrl?: string;
  /** Where the script and collect endpoint are mounted. Default "/agent-guard". */
  mountPath?: string;
  /** Max time to wait for the scoring API, ms. Default 1500. */
  timeoutMs?: number;
}

export interface AgentGuardRequestInfo {
  /** Session id from the ag_sid cookie, if the page loaded the client script */
  sid: string | null;
  /** Last known verdict for this session (from the most recent signal batch) */
  verdict: Verdict;
  /** Ask the scoring API for the latest verdict. Never throws. */
  check(): Promise<ScoreResult>;
}

declare module 'http' {
  interface IncomingMessage {
    agentGuard?: AgentGuardRequestInfo;
  }
}

type Next = (err?: unknown) => void;
type Req = IncomingMessage & { body?: unknown; originalUrl?: string };

const MAX_BODY_BYTES = 16 * 1024;
const MAX_CACHED_SESSIONS = 10_000;

let clientScript: Buffer | null = null;
function loadClientScript(): Buffer {
  clientScript ??= readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)));
  return clientScript;
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

async function readJson(req: Req): Promise<unknown> {
  // Already parsed by express.json() or similar
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function unknownResult(sid: string, reason: string): ScoreResult {
  return { sid, verdict: 'unknown', score: 0, reasons: [reason] };
}

export function agentGuard(options: AgentGuardOptions = {}) {
  const apiKey = options.apiKey ?? process.env.AGENT_GUARD_API_KEY;
  const apiUrl = (options.apiUrl ?? process.env.AGENT_GUARD_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
  const mountPath = (options.mountPath ?? '/agent-guard').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 1500;

  if (!apiKey) {
    console.warn('[agent-guard] No API key set. Verdicts will be "unknown". Set AGENT_GUARD_API_KEY.');
  }

  // Most recent result per session, so req.agentGuard.verdict is available without a network call.
  const cache = new Map<string, ScoreResult>();
  const remember = (result: ScoreResult) => {
    cache.delete(result.sid);
    cache.set(result.sid, result);
    if (cache.size > MAX_CACHED_SESSIONS) cache.delete(cache.keys().next().value!);
  };

  async function callApi(path: string, init: RequestInit, sid: string): Promise<ScoreResult> {
    if (!apiKey) return unknownResult(sid, 'agent-guard is not configured (missing API key)');
    try {
      const res = await fetch(apiUrl + path, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401) return unknownResult(sid, 'agent-guard API key was rejected');
      if (res.status === 402) return unknownResult(sid, 'agent-guard plan limit reached');
      if (!res.ok) return unknownResult(sid, `agent-guard API error (${res.status})`);
      const result = (await res.json()) as ScoreResult;
      remember(result);
      return result;
    } catch {
      // Fail open: an outage on our side must never block a student.
      return cache.get(sid) ?? unknownResult(sid, 'agent-guard API unreachable');
    }
  }

  return async function agentGuardMiddleware(req: Req, res: ServerResponse, next: Next) {
    const url = new URL(req.originalUrl ?? req.url ?? '/', 'http://local');

    if (url.pathname === `${mountPath}/client.js` && req.method === 'GET') {
      res.setHeader('content-type', 'application/javascript; charset=utf-8');
      res.setHeader('cache-control', 'public, max-age=3600');
      res.end(loadClientScript());
      return;
    }

    if (url.pathname === `${mountPath}/collect` && req.method === 'POST') {
      try {
        const batch = (await readJson(req)) as SignalBatch;
        if (batch?.v !== 1 || typeof batch.sid !== 'string' || batch.sid.length > 64) {
          res.statusCode = 400;
          res.end();
          return;
        }
        // Wait for the API so a check() right after flush() sees this batch.
        await callApi('/v1/collect', { method: 'POST', body: JSON.stringify(batch) }, batch.sid);
        // Answer without the verdict: an agent must not be able to read its own score and adapt.
        res.statusCode = 204;
        res.end();
      } catch {
        if (!res.writableEnded) {
          res.statusCode = 400;
          res.end();
        }
      }
      return;
    }

    const sid = readCookie(req, 'ag_sid');
    req.agentGuard = {
      sid,
      verdict: sid ? (cache.get(sid)?.verdict ?? 'unknown') : 'unknown',
      check: () =>
        sid
          ? callApi(`/v1/sessions/${encodeURIComponent(sid)}`, { method: 'GET' }, sid)
          : Promise.resolve(unknownResult('', 'No agent-guard session (client script not loaded)')),
    };
    next();
  };
}

export default agentGuard;
