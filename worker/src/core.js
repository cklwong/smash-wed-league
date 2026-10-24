// One event date's database: the logic behind the EventDO Durable Object
// (src/index.js), kept free of Cloudflare APIs so test/ can run it in Node.
//
// How it works (see ../README.md):
//   - `base` is the week exactly as Apps Script last reported it (Code.gs
//     syncSnapshot); `st` is base plus every action not yet confirmed by
//     Apps Script - what the site is shown.
//   - An action is checked (sign-in, then the same rules Code.gs applies -
//     site/week-engine.js), applied to `st`, queued, and answered right away.
//   - In the background (the alarm) queued actions go to Code.gs's syncBatch
//     in order; its reply carries a fresh snapshot that becomes the new
//     `base`, and anything still queued is re-applied on top. So Code.gs and
//     the sheet stay the source of truth, and any difference between the two
//     rule copies (or a hand edit in the sheet) corrects itself on the next
//     sync.

import rules from '../../site/relay-rules.js';
import engineModule from '../../site/week-engine.js';

export const E = engineModule.createWeekEngine(rules);

// Actions that need the admin passphrase or tonight's PIN (Code.gs
// checkRunAuth); join/leave are open to anyone, like Code.gs.
const OPEN_ACTIONS = new Set(['join', 'leave']);
export const LOCAL_ACTIONS = new Set(E.ACTIONS.concat(['verifyPin', 'syncReload']));

const BATCH_MAX = 20;                   // ops per syncBatch call
const BATCH_DELAY_MS = 400;             // groups a burst of taps into one batch
const IDLE_REFRESH_MS = 10 * 60 * 1000; // re-read the sheet when idle and older than this
const MISSING_REFRESH_MS = 60 * 1000;   // ...or this, for a date with no tab yet
const AUTH_REFRESH_MS = 15 * 1000;      // re-fetch sign-in hashes at most this often on a miss
const RETRY_MS = [2000, 5000, 15000, 30000, 60000, 120000];
const CONFLICTS_KEPT = 20;
const DRAIN_TIMEOUT_MS = 60 * 1000;
const LOAD_RETRY_MS = 60 * 1000;        // after a failed first load, don't retry for this long

export async function sha256Hex(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function emptyState(date) {
  return {
    date, base: null, st: null, queue: [], inflight: [], seq: 0,
    ranks: [], bans: {}, auth: { admin: null, pin: null }, authAt: 0,
    hydratedAt: 0, syncedAt: 0, wantRefresh: false,
    lastError: null, retries: 0, conflicts: [], relayRev: 0
  };
}

// The fields of a site request worth replaying - never the passphrase/PIN
// (Code.gs's syncBatch runs replays as the organizer instead).
function opFromBody(body) {
  const op = {};
  for (const k of Object.keys(body)) if (k !== 'secret' && k !== 'pin' && k !== 'key' && k !== 'date') op[k] = body[k];
  return op;
}

function describeOp(op) {
  const who = op.name || op.oldName || (op.a && op.b ? op.a + ' vs ' + op.b : '') || op.matchId || '';
  return op.action + (who ? ' (' + who + ')' : '');
}

export class EventCore {
  // storage: {get(k), put(k, v), getAlarm(), setAlarm(ms)}; gas(body) -> JSON
  // reply from Code.gs; date: this object's event date (YYYY-MM-DD).
  constructor({ storage, gas, date, now }) {
    this.storage = storage;
    this.gas = gas;
    this.date = date;
    this.now = now || (() => Date.now());
    this.s = null;
    this.chain = Promise.resolve();
  }

  async load() {
    if (!this.s) this.s = (await this.storage.get('s')) || emptyState(this.date);
    return this.s;
  }
  async save() { await this.storage.put('s', this.s); }

  // Every Apps Script call goes through one chain, so a hydrate and a batch
  // never overlap and snapshots always arrive in order.
  serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async scheduleAlarm(delayMs) {
    const at = this.now() + delayMs;
    const cur = await this.storage.getAlarm();
    if (cur == null || cur > at) await this.storage.setAlarm(at);
  }

  // The first read of a date loads it from Apps Script. If that fails, the
  // Worker answers from Apps Script directly instead (src/index.js); for
  // LOAD_RETRY_MS after a failure this throws at once with the same error,
  // so every request doesn't pay for a doomed load first.
  async ensureLoaded() {
    await this.load();
    if (this.s.base) return this.s;
    if (this.loadError && this.now() - this.loadError.at < LOAD_RETRY_MS) throw new Error(this.loadError.message);
    try {
      await this.serial(() => this.hydrate());
    } catch (err) {
      this.loadError = { at: this.now(), message: String(err && err.message || err) };
      throw err;
    }
    this.loadError = null;
    return this.s;
  }

  // ---- talking to Apps Script ----

  async gasCall(body) {
    const r = await this.gas(body);
    if (!r || r.ok !== true) throw new Error((r && r.error) || 'Apps Script call failed');
    return r;
  }

  async hydrate() {
    const r = await this.gasCall({ action: 'syncHydrate', date: this.date });
    const s = this.s;
    s.ranks = r.ranks || [];
    s.bans = r.bans || {};
    s.auth = r.auth || { admin: null, pin: null };
    s.authAt = this.now();
    this.adopt(r.snapshot);
    s.hydratedAt = this.now();
    s.wantRefresh = false;
    await this.save();
  }

  // A fresh snapshot from Code.gs becomes the base; actions it hasn't seen
  // yet are re-applied on top.
  adopt(snapshot) {
    const s = this.s;
    s.base = E.fromView(snapshot.week, { markers: snapshot.markers, guestMap: snapshot.guestMap, ranks: s.ranks, bans: s.bans });
    this.rebase();
    s.syncedAt = this.now();
  }

  rebase() {
    const s = this.s;
    const before = s.st;
    const st = E.clone(s.base);
    st.ranks = s.ranks; st.bans = s.bans;
    for (const op of s.inflight.concat(s.queue)) {
      // A team edit was checked against the rev the site saw when it was
      // made; Code.gs's own rev numbering differs, so don't re-check it.
      const o = op.action === 'relaySaveTeams' ? Object.assign({}, op, { rev: st.relay ? st.relay.rev : 0 }) : op;
      try { E.apply(st, o, op.at); } catch (err) { /* a replay that no longer fits; Code.gs decides */ }
    }
    // The relay rev the site sees only ever moves forward, and moves on any
    // change - Code.gs counts its own revs, so its number can't be shown as-is.
    if (st.relay) {
      const strip = (r) => r ? JSON.stringify({ t: r.teams, g: r.games, q: r.requests || [], u: r.guests || [] }) : '';
      let rev = Math.max(s.relayRev || 0, before && before.relay ? before.relay.rev : 0);
      if (!before || strip(before.relay) !== strip(st.relay)) rev++;
      st.relay.rev = rev;
      s.relayRev = rev;
    }
    s.st = st;
  }

  // Sends queued ops to Code.gs (one batch). Returns true if more remain.
  async flush() {
    const s = this.s;
    if (!s.inflight.length) {
      s.inflight = s.queue.splice(0, BATCH_MAX);
      await this.save();
    }
    if (!s.inflight.length) return false;
    const sent = s.inflight.slice();
    const r = await this.gasCall({ action: 'syncBatch', date: this.date, ops: sent });
    const processed = Math.max(0, Math.min(sent.length, Number(r.processed) || 0));
    (r.results || []).slice(0, processed).forEach((res, i) => {
      if (res && res.ok === false) {
        s.conflicts.push({ at: sent[i].at, op: describeOp(sent[i]), error: res.error || 'refused' });
      }
    });
    if (s.conflicts.length > CONFLICTS_KEPT) s.conflicts = s.conflicts.slice(-CONFLICTS_KEPT);
    // Unprocessed ops (Code.gs's time budget ran out) go back to the front.
    s.queue = sent.slice(processed).concat(s.queue);
    s.inflight = [];
    this.adopt(r.snapshot);
    s.finalized = s.finalized || !!r.finalize;
    await this.save();
    return s.queue.length > 0;
  }

  // Waits until every queued op has reached Code.gs (for admin actions that
  // must see the sheet up to date). Throws if Apps Script keeps failing.
  async drain() {
    const deadline = this.now() + DRAIN_TIMEOUT_MS;
    await this.load();
    while (this.s.queue.length || this.s.inflight.length) {
      if (this.now() > deadline) throw new Error('The sheet is still catching up — try again in a minute.');
      await this.serial(() => this.flush());
    }
  }

  // The background job: send what's queued, else re-read the sheet if asked.
  // Returns {finalized} so the Worker can refresh the standings cache.
  async alarm() {
    await this.load();
    const s = this.s;
    let finalized = false;
    try {
      if (s.queue.length || s.inflight.length) {
        const more = await this.serial(() => this.flush());
        if (more) await this.scheduleAlarm(0);
      } else if (s.wantRefresh || !s.base) {
        await this.serial(() => this.hydrate());
      }
      s.retries = 0;
      s.lastError = null;
    } catch (err) {
      s.lastError = String(err && err.message || err);
      const wait = RETRY_MS[Math.min(s.retries, RETRY_MS.length - 1)];
      s.retries++;
      await this.scheduleAlarm(wait);
    }
    if (s.finalized) { finalized = true; s.finalized = false; }
    await this.save();
    return { finalized };
  }

  // ---- sign-in (Code.gs checkAdminSecret / checkPin / checkRunAuth) ----

  async refreshAuth(force) {
    const s = this.s;
    if (!force && this.now() - s.authAt < AUTH_REFRESH_MS) return false;
    s.authAt = this.now();
    try {
      const r = await this.gasCall({ action: 'syncAuth', date: this.date });
      s.auth = r.auth || s.auth;
      await this.save();
      return true;
    } catch (err) {
      return false;
    }
  }

  async checkAdmin(secret) {
    const want = this.s.auth.admin;
    const got = secret ? await sha256Hex(secret) : null;
    if (got && want && got === want) return { ok: true };
    if (got && await this.refreshAuth() && this.s.auth.admin === got) return { ok: true };
    if (!this.s.auth.admin) return { ok: false, error: 'ADMIN_SECRET script property is not set — set it in Apps Script project settings.' };
    return { ok: false, error: 'Wrong passphrase.' };
  }

  async checkPin(pin) {
    const p = String(pin || '').trim();
    const got = p ? await sha256Hex(p) : null;
    if (got && this.s.auth.pin === got) return { ok: true };
    if (await this.refreshAuth() && got && this.s.auth.pin === got) return { ok: true };
    if (!this.s.auth.pin) return { ok: false, error: 'No PIN issued for ' + this.date + ' yet — retrieve it from the organizer panel first.' };
    return { ok: false, error: 'Wrong PIN.' };
  }

  async checkRunAuth(secret, pin) {
    if (secret) {
      const a = await this.checkAdmin(secret);
      if (a.ok || !pin) return a;
    }
    if (pin) return this.checkPin(pin);
    return { ok: false, error: 'Sign in required.' };
  }

  // The Admin tab's getpin went through: remember the PIN's hash.
  async setPinHash(hash) {
    await this.load();
    this.s.auth.pin = hash;
    await this.save();
  }

  // ---- what the site calls ----

  async week() {
    const s = await this.ensureLoaded();
    const age = this.now() - s.hydratedAt;
    const idle = !s.queue.length && !s.inflight.length;
    if (idle && !s.wantRefresh && (age > IDLE_REFRESH_MS || (!s.st.exists && age > MISSING_REFRESH_MS))) {
      s.wantRefresh = true;
      await this.save();
      await this.scheduleAlarm(0);
    }
    const view = E.toView(s.st);
    view.sync = {
      pending: s.queue.length + s.inflight.length,
      error: s.lastError,
      conflicts: s.conflicts.slice(-5)
    };
    view.now = this.now();
    return view;
  }

  async action(body) {
    const s = await this.ensureLoaded();
    const action = body.action;
    if (!OPEN_ACTIONS.has(action)) {
      const auth = action === 'syncReload' ? await this.checkAdmin(body.secret)
        : action === 'verifyPin' ? await this.checkPin(body.pin)
        : await this.checkRunAuth(body.secret, body.pin);
      if (!auth.ok) return auth;
    }
    if (action === 'verifyPin') return { ok: true };
    if (action === 'syncReload') {
      await this.drain();
      await this.serial(() => this.hydrate());
      return { ok: true, week: await this.week() };
    }
    const op = opFromBody(body);
    if (action === 'startMatch' && !(typeof op.id === 'string' && op.id && op.id.length <= 64)) op.id = crypto.randomUUID();
    op.at = this.now();
    op.n = ++s.seq;
    const draft = E.clone(s.st);
    draft.ranks = s.ranks; draft.bans = s.bans;
    const result = E.apply(draft, op, op.at);
    if (!result || result.ok === false) {
      if (result && result.relay) result.relay.rev = s.st.relay ? s.st.relay.rev : result.relay.rev;
      return result;
    }
    // Same rev rule as rebase(): the site's relay rev moves on every change.
    if (draft.relay && s.st.relay && JSON.stringify(draft.relay) !== JSON.stringify(s.st.relay)) {
      s.relayRev = Math.max(s.relayRev || 0, s.st.relay.rev) + 1;
      draft.relay.rev = s.relayRev;
      if (result.relay) result.relay.rev = s.relayRev;
    } else if (draft.relay && !s.st.relay) {
      s.relayRev = Math.max(s.relayRev || 0, draft.relay.rev);
    }
    s.st = draft;
    s.queue.push(op);
    await this.save();
    await this.scheduleAlarm(BATCH_DELAY_MS);
    return result;
  }

  // Admin actions that rewrite the whole week (finalize, reset, format
  // switch): everything queued reaches the sheet first, then Code.gs runs
  // it with the organizer's own passphrase, then the week is re-read.
  async passthrough(body) {
    await this.load();
    await this.drain();
    const r = await this.gas(body);
    try { await this.serial(() => this.hydrate()); } catch (err) { /* the next read retries */ }
    return r;
  }

  // The sheet may have changed outside this object (a rename, a ban, a new
  // tab): re-read it in the background.
  async requestRefresh() {
    await this.load();
    this.s.wantRefresh = true;
    await this.save();
    await this.scheduleAlarm(0);
  }

  async status() {
    const s = await this.load();
    return { date: s.date, loaded: !!s.base, pending: s.queue.length + s.inflight.length, lastError: s.lastError, hydratedAt: s.hydratedAt, syncedAt: s.syncedAt, conflicts: s.conflicts };
  }
}
