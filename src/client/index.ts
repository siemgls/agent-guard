import type { EnvSignals, EventCounters, SignalBatch, TimingStats } from '../shared/types';

const COOKIE = 'ag_sid';
const FLUSH_INTERVAL_MS = 5000;

const AUTOMATION_GLOBALS = [
  '__playwright__binding__',
  '__pwInitScripts',
  '_phantom',
  'callPhantom',
  '__nightmare',
  'domAutomation',
  'domAutomationController',
  '__webdriver_evaluate',
  '__selenium_unwrapped',
  '__webdriver_script_fn',
  '__driver_evaluate',
  '__lastWatirAlert',
  'Cypress',
];

declare global {
  interface Window {
    agentGuard?: { sid: string; flush: () => Promise<void> };
  }
}

function getSessionId(): string {
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`));
  if (match) return match[1];
  const sid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  // Session cookie so the server can match the quiz submit to these signals.
  document.cookie = `${COOKIE}=${sid}; path=/; SameSite=Lax`;
  return sid;
}

function resolveEndpoint(): string {
  const script = document.currentScript as HTMLScriptElement | null;
  if (script?.dataset.endpoint) return script.dataset.endpoint;
  if (script?.src) return script.src.replace(/client\.js(\?.*)?$/, 'collect');
  return '/agent-guard/collect';
}

function readEnv(): EnvSignals {
  const w = window as unknown as Record<string, unknown>;
  const found = AUTOMATION_GLOBALS.filter((k) => k in w);
  // ChromeDriver leaves $cdc_ / $wdc_ properties on document.
  for (const k of Object.keys(document)) {
    if (/^\$?(cdc|wdc)_/.test(k)) found.push(k);
  }
  return {
    webdriver: navigator.webdriver === true,
    automationGlobals: found,
    headlessUA: /Headless/i.test(navigator.userAgent),
    // Headless: no outer window but a real viewport. Real browsers also report 0
    // while minimized or in a background tab, so only trust it while visible.
    zeroOuterSize:
      document.visibilityState === 'visible' &&
      window.outerWidth === 0 &&
      window.outerHeight === 0 &&
      window.innerWidth > 0,
    touchPrimary: matchMedia?.('(pointer: coarse)').matches ?? false,
  };
}

function emptyEvents(): EventCounters {
  return {
    untrusted: 0,
    clicks: 0,
    clicksWithoutMovement: 0,
    mouseMoves: 0,
    keydowns: 0,
    inputsWithoutKeydown: 0,
    composedInputs: 0,
    compositionStarts: 0,
    processKeydowns: 0,
    pastes: 0,
    scrolls: 0,
    blurs: 0,
  };
}

function emptyTiming(): TimingStats {
  return { keyIntervals: 0, keyIntervalMean: 0, keyIntervalM2: 0, pathSamples: 0, pathStraightnessSum: 0 };
}

function start(): void {
  if (window.agentGuard) return; // loaded twice

  const sid = getSessionId();
  const endpoint = resolveEndpoint();
  const t0 = performance.now();

  let seq = 0;
  let events = emptyEvents();
  let timing = emptyTiming();
  let firstInteractionMs: number | undefined;
  let firstInteractionSent = false;
  let dirty = true; // send the env check right away

  // Recent mouse positions, used for "moves before click" and path straightness.
  const recentMoves: { x: number; y: number; t: number }[] = [];
  let lastKeydownAt = -Infinity;
  let lastKeyAt: number | null = null;

  const markInteraction = (e: Event) => {
    if (!e.isTrusted) events.untrusted++;
    if (firstInteractionMs === undefined && e.isTrusted) firstInteractionMs = Math.round(performance.now() - t0);
    dirty = true;
  };

  addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse') return;
      events.mouseMoves++;
      const now = performance.now();
      recentMoves.push({ x: e.clientX, y: e.clientY, t: now });
      while (recentMoves.length && now - recentMoves[0].t > 1000) recentMoves.shift();
      if (!e.isTrusted) events.untrusted++;
      dirty = true;
    },
    { passive: true, capture: true },
  );

  addEventListener(
    'click',
    (e) => {
      markInteraction(e);
      events.clicks++;
      const now = performance.now();
      const moves = recentMoves.filter((m) => now - m.t <= 1000);
      // Keyboard "clicks" (Enter/Space on a button) have detail 0 and no pointer.
      const fromPointer = (e as MouseEvent).detail > 0;
      if (fromPointer && moves.length < 2) events.clicksWithoutMovement++;
      if (moves.length >= 3) {
        let pathLen = 0;
        for (let i = 1; i < moves.length; i++) {
          pathLen += Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y);
        }
        const direct = Math.hypot(moves[moves.length - 1].x - moves[0].x, moves[moves.length - 1].y - moves[0].y);
        if (direct > 50 && pathLen > 0) {
          timing.pathSamples++;
          timing.pathStraightnessSum += direct / pathLen;
        }
      }
      recentMoves.length = 0;
    },
    { capture: true },
  );

  addEventListener(
    'keydown',
    (e) => {
      markInteraction(e);
      events.keydowns++;
      if (e.keyCode === 229 || e.key === 'Process') events.processKeydowns++;
      const now = performance.now();
      lastKeydownAt = now;
      if (lastKeyAt !== null) {
        const dt = now - lastKeyAt;
        // Only count typing bursts, not pauses between questions.
        if (dt < 2000) {
          // Welford's online mean/variance
          timing.keyIntervals++;
          const delta = dt - timing.keyIntervalMean;
          timing.keyIntervalMean += delta / timing.keyIntervals;
          timing.keyIntervalM2 += delta * (dt - timing.keyIntervalMean);
        }
      }
      lastKeyAt = now;
    },
    { capture: true },
  );

  addEventListener(
    'input',
    (e) => {
      const ie = e as InputEvent;
      if (ie.inputType === 'insertFromPaste') return; // counted by 'paste'
      if (ie.inputType?.startsWith('insert') && performance.now() - lastKeydownAt > 100) {
        events.inputsWithoutKeydown++;
        if (ie.isComposing || ie.inputType === 'insertCompositionText') events.composedInputs++;
        dirty = true;
      }
    },
    { capture: true },
  );

  addEventListener('compositionstart', () => {
    events.compositionStarts++;
    dirty = true;
  }, { capture: true });

  addEventListener('paste', (e) => {
    markInteraction(e);
    events.pastes++;
  }, { capture: true });

  addEventListener('scroll', () => {
    events.scrolls++;
    dirty = true;
  }, { passive: true, capture: true });

  addEventListener('blur', () => {
    events.blurs++;
    dirty = true;
  });

  const buildBatch = (): SignalBatch => {
    const batch: SignalBatch = {
      v: 1,
      sid,
      seq: seq++,
      t: Math.round(performance.now() - t0),
      env: readEnv(),
      events,
      timing,
    };
    if (firstInteractionMs !== undefined && !firstInteractionSent) {
      batch.firstInteractionMs = firstInteractionMs;
      firstInteractionSent = true;
    }
    events = emptyEvents();
    timing = emptyTiming();
    dirty = false;
    return batch;
  };

  // Last request sent, so flush() can wait for one that is already on its way.
  let inflight: Promise<void> = Promise.resolve();

  const send = () => {
    if (!dirty) return;
    const body = JSON.stringify(buildBatch());
    inflight = fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true, // survives navigation, e.g. a form submit
      credentials: 'same-origin',
    }).then(
      () => undefined,
      () => undefined, // Detection must never break the quiz page.
    );
  };

  const flush = (): Promise<void> => {
    send();
    return inflight;
  };

  const beacon = () => {
    if (!dirty) return;
    const body = JSON.stringify(buildBatch());
    if (!navigator.sendBeacon?.(endpoint, new Blob([body], { type: 'application/json' }))) {
      void fetch(endpoint, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } });
    }
  };

  setInterval(send, FLUSH_INTERVAL_MS);
  addEventListener('submit', send, { capture: true });
  addEventListener('pagehide', beacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') beacon();
  });

  window.agentGuard = { sid, flush };
  send();
}

start();
