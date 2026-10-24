// Smash Wed league API on Cloudflare Workers - sits between the site
// (site/index.html, which calls it instead of Apps Script when WORKER_URL is
// set) and the Apps Script backend (gas/Code.gs). See ../README.md.
//
//   GET  ?action=week&date=...     -> that date's EventDO (instant, from its own copy)
//   GET  ?action=rankings|weekDates|headtohead -> MetaDO (cached, refreshed in the background)
//   POST game-day actions + join/leave + verifyPin + syncReload -> that date's EventDO
//   POST finalizeRankings/resetWeek/setEventFormat -> EventDO passthrough (sheet caught up first)
//   POST anything else (admin tools)  -> straight to Apps Script, as before
//
// Secrets/vars: SYNC_KEY (secret, same value as Code.gs's SYNC_KEY script
// property), GAS_URL (var, the Apps Script web-app URL).

import { DurableObject } from 'cloudflare:workers';
import { EventCore, LOCAL_ACTIONS, sha256Hex } from './core.js';
import { MetaCore } from './meta.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PASSTHROUGH_DATED = new Set(['finalizeRankings', 'resetWeek', 'setEventFormat']);
const MAX_BODY = 64 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS)
  });
}

// Code.gs's web app answers POSTs with a redirect to the JSON; fetch follows it.
async function gasPost(env, body) {
  const r = await fetch(env.GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow'
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch (err) { throw new Error('Apps Script returned HTTP ' + r.status + ' (not JSON)'); }
}

async function gasGet(env, query) {
  const r = await fetch(env.GAS_URL + '?' + query, { redirect: 'follow' });
  const text = await r.text();
  try { return JSON.parse(text); } catch (err) { throw new Error('Apps Script returned HTTP ' + r.status + ' (not JSON)'); }
}

// Plausible event dates only, so stray requests can't mint objects for any
// string: real calendar dates within about a year of today.
function validDate(d) {
  if (!DATE_RE.test(d || '')) return false;
  const t = Date.parse(d + 'T12:00:00Z');
  return isFinite(t) && Math.abs(t - Date.now()) < 400 * 86400000 && new Date(t).toISOString().slice(0, 10) === d;
}

function eventStub(env, date) { return env.EVENTS.get(env.EVENTS.idFromName(date)); }
function metaStub(env) { return env.META.get(env.META.idFromName('meta')); }

// ---- Durable Objects ----

export class EventDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.core = null;
  }
  coreFor(date) {
    if (!this.core) {
      const storage = this.ctx.storage;
      this.core = new EventCore({
        date,
        storage: {
          get: (k) => storage.get(k),
          put: (k, v) => storage.put(k, v),
          getAlarm: () => storage.getAlarm(),
          setAlarm: (ms) => storage.setAlarm(ms)
        },
        gas: (body) => gasPost(this.env, Object.assign({ key: this.env.SYNC_KEY }, body))
      });
    }
    return this.core;
  }
  async week(date) { return this.coreFor(date).week(); }
  async action(date, body) { return this.coreFor(date).action(body); }
  async passthrough(date, body) { return this.coreFor(date).passthrough(body); }
  async setPinHash(date, hash) { return this.coreFor(date).setPinHash(hash); }
  async requestRefresh(date) { return this.coreFor(date).requestRefresh(); }
  async status(date) { return this.coreFor(date).status(); }
  async alarm() {
    const s = await this.ctx.storage.get('s');
    if (!s || !s.date) return;
    const r = await this.coreFor(s.date).alarm();
    if (r && r.finalized) await metaStub(this.env).invalidate(['rankings', 'weekDates', 'headtohead']);
  }
}

export class MetaDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const storage = ctx.storage;
    this.core = new MetaCore({
      storage: {
        get: (k) => storage.get(k),
        put: (k, v) => storage.put(k, v),
        delete: (k) => storage.delete(k),
        setAlarm: (ms) => storage.setAlarm(ms)
      },
      gasGet: (q) => gasGet(env, q)
    });
  }
  async get(kind, name) { return this.core.get(kind, name); }
  async invalidate(kinds) { return this.core.invalidate(kinds); }
  async alarm() { return this.core.alarm(); }
}

// ---- router ----

// Event dates from today on (Pacific-ish: from yesterday UTC), for refreshing
// open weeks after a rename or ban.
async function upcomingDates(env) {
  try {
    const wd = await metaStub(env).get('weekDates');
    const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    return (wd.dates || []).filter((d) => d >= from && validDate(d));
  } catch (err) {
    return [];
  }
}

async function handleGet(url, env) {
  const action = url.searchParams.get('action') || '';
  if (action === 'week') {
    const date = url.searchParams.get('date') || '';
    if (!validDate(date)) return json(await gasGet(env, url.searchParams.toString()));
    try {
      return json(await eventStub(env, date).week(date));
    } catch (err) {
      // No copy yet and it couldn't be loaded from Apps Script (often a
      // SYNC_KEY mismatch, or Code.gs not redeployed): ask Apps Script
      // directly, exactly as the site used to, and say why in `sync` so the
      // Admin tab's Sheet sync box shows it.
      const week = await gasGet(env, url.searchParams.toString());
      if (week && typeof week === 'object') week.sync = { pending: 0, conflicts: [], direct: true, error: 'Could not load this week into the site\'s database: ' + String(err && err.message || err) };
      return json(week);
    }
  }
  if (action === 'rankings' || action === 'weekDates' || action === 'headtohead') {
    try {
      return json(await metaStub(env).get(action, url.searchParams.get('name') || ''));
    } catch (err) {
      return json(await gasGet(env, url.searchParams.toString()));
    }
  }
  if (action === 'health') return json({ ok: true, worker: 'smash-wed' });
  return json(await gasGet(env, url.searchParams.toString()));
}

async function handlePost(req, env, ctx) {
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: 'Request too large.' }, 413);
  let body;
  try { body = JSON.parse(text || '{}'); } catch (err) { return json({ ok: false, error: 'Bad JSON.' }, 400); }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'Bad request.' }, 400);
  // The sync actions are for this Worker only.
  if (/^sync/.test(body.action || '') && body.action !== 'syncReload') return json({ ok: false, error: 'unknown action: ' + body.action });
  const date = body.date;

  if (LOCAL_ACTIONS.has(body.action) && validDate(date)) {
    let res;
    try {
      res = await eventStub(env, date).action(date, body);
    } catch (err) {
      if (body.action === 'syncReload') return json({ ok: false, error: String(err && err.message || err) });
      // Couldn't load this date's copy (Apps Script unreachable from the
      // object): fall back to Apps Script directly - nothing is queued yet.
      return json(await gasPost(env, body));
    }
    return json(res);
  }

  if (PASSTHROUGH_DATED.has(body.action) && validDate(date)) {
    let res;
    try {
      res = await eventStub(env, date).passthrough(date, body);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) });
    }
    if (res && res.ok) ctx.waitUntil(metaStub(env).invalidate(body.action === 'setEventFormat' ? ['weekDates'] : ['rankings', 'weekDates', 'headtohead']));
    return json(res);
  }

  const res = await gasPost(env, body);
  if (res && res.ok) {
    if (body.action === 'getpin' && res.pin && validDate(date)) {
      ctx.waitUntil(sha256Hex(String(res.pin)).then((h) => eventStub(env, date).setPinHash(date, h)));
    } else if (body.action === 'createWeek') {
      ctx.waitUntil((async () => {
        await metaStub(env).invalidate(['weekDates']);
        if (validDate(res.date)) await eventStub(env, res.date).requestRefresh(res.date);
      })());
    } else if (body.action === 'renamePlayer' || body.action === 'banPlayer' || body.action === 'unbanPlayer') {
      ctx.waitUntil((async () => {
        if (body.action === 'renamePlayer') await metaStub(env).invalidate(['rankings', 'headtohead']);
        for (const d of await upcomingDates(env)) await eventStub(env, d).requestRefresh(d);
      })());
    }
  }
  return json(res);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    try {
      if (req.method === 'GET') return await handleGet(url, env);
      if (req.method === 'POST') return await handlePost(req, env, ctx);
      return json({ ok: false, error: 'Method not allowed.' }, 405);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 502);
    }
  }
};
