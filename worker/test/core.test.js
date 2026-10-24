// Runs the Worker's event logic (src/core.js) against a fake Apps Script:
// the "sheet" is another copy of the week driven by the same engine, so a
// replayed batch lands the way Code.gs's syncBatch would land it.
//   cd worker && npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventCore, E, sha256Hex } from '../src/core.js';
import { MetaCore } from '../src/meta.js';

const DATE = '2026-11-04';
const NAMES = Array.from({ length: 26 }, (_, i) => 'Player ' + String(i + 1).padStart(2, '0'));

function memStorage() {
  const m = new Map();
  let alarm = null;
  return {
    m,
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    delete: async (k) => { m.delete(k); },
    getAlarm: async () => alarm,
    setAlarm: async (ms) => { alarm = ms; },
    clearAlarm: () => { alarm = null; },
    alarmAt: () => alarm
  };
}

// The fake Apps Script: a truth copy of the week plus the sync endpoints.
function fakeGas({ relay = false, secret = 'pass', pin = '123456' } = {}) {
  const truth = E.fromView({
    date: DATE, exists: true,
    signups: NAMES.map((name, i) => ({ name, checkedIn: false, noShow: false })),
    pools: [], live: { matches: [], checkins: {}, walkins: [] },
    event: relay ? E.relayEvent('exhibition') : undefined
  }, { ranks: NAMES, bans: {} });
  const g = {
    truth, calls: [], fail: 0, delay: null, refuse: null, hashes: null,
    snapshot() {
      const markers = [];
      Object.keys(truth.grids).forEach((L) => truth.grids[L].forEach((row, r) => row.forEach((v, c) => { if (v === 'p') markers.push([L, r, c]); })));
      return { week: E.toView(truth), markers, guestMap: E.clone(truth.guestMap) };
    },
    async call(body) {
      g.calls.push(body);
      if (!g.hashes) g.hashes = { admin: await sha256Hex(secret), pin: pin ? await sha256Hex(pin) : null };
      if (g.delay) await g.delay();
      if (g.fail > 0) { g.fail--; throw new Error('network down'); }
      if (body.action === 'syncHydrate') return { ok: true, snapshot: g.snapshot(), ranks: NAMES, bans: {}, auth: g.hashes };
      if (body.action === 'syncAuth') return { ok: true, auth: g.hashes };
      if (body.action === 'syncBatch') {
        const results = body.ops.map((op) => {
          if (g.refuse && g.refuse(op)) return { ok: false, error: 'refused by sheet' };
          const o = op.action === 'relaySaveTeams' ? Object.assign({}, op, { rev: truth.relay.rev }) : op;
          const r = E.apply(truth, o, op.at);
          delete r.relay;
          return r;
        });
        return { ok: true, processed: results.length, results, snapshot: g.snapshot() };
      }
      return { ok: true, passthrough: body.action };
    }
  };
  return g;
}

function makeCore(gas, clock) {
  const storage = memStorage();
  let t = 1000000;
  const now = clock || (() => t);
  const core = new EventCore({ storage, gas: (b) => gas.call(b), date: DATE, now });
  core.tick = (ms) => { t += ms; };
  core.storageRef = storage;
  return core;
}

const ADMIN = { secret: 'pass' };

test('an action is answered from the copy, then replayed to the sheet', async () => {
  const gas = fakeGas();
  const core = makeCore(gas);
  const r = await core.action({ action: 'checkin', date: DATE, name: 'Player 05', ...ADMIN });
  assert.equal(r.ok, true);
  let w = await core.week();
  assert.equal(w.signups[4].checkedIn, true);
  assert.equal(w.sync.pending, 1);
  assert.equal(gas.truth.signups[4].checkedIn, false, 'not on the sheet yet');
  const batch = gas.calls.filter((c) => c.action === 'syncBatch');
  assert.equal(batch.length, 0);
  await core.alarm();
  assert.equal(gas.truth.signups[4].checkedIn, true, 'replayed');
  const sent = gas.calls.find((c) => c.action === 'syncBatch').ops[0];
  assert.equal(sent.secret, undefined, 'passphrase never forwarded');
  w = await core.week();
  assert.equal(w.sync.pending, 0);
  assert.equal(w.signups[4].checkedIn, true);
});

test('sign-in: wrong passphrase, PIN, and open join', async () => {
  const gas = fakeGas();
  const core = makeCore(gas);
  assert.equal((await core.action({ action: 'checkin', date: DATE, name: 'Player 01', secret: 'nope' })).error, 'Wrong passphrase.');
  assert.equal((await core.action({ action: 'checkin', date: DATE, name: 'Player 01' })).error, 'Sign in required.');
  assert.equal((await core.action({ action: 'checkin', date: DATE, name: 'Player 01', pin: '123456' })).ok, true);
  assert.equal((await core.action({ action: 'verifyPin', date: DATE, pin: '000000' })).error, 'Wrong PIN.');
  assert.equal((await core.action({ action: 'verifyPin', date: DATE, pin: '123456' })).ok, true);
  const j = await core.action({ action: 'join', date: DATE, name: 'New Person', contact: 'a@b.co' });
  assert.deepEqual([j.ok, j.position, j.cap], [true, 27, 24]);
  assert.equal((await core.action({ action: 'join', date: DATE, name: 'new person' })).error, 'Already signed up');
});

test('a PIN issued after the copy loaded is picked up on the next sign-in', async () => {
  const gas = fakeGas({ pin: null });
  const core = makeCore(gas);
  assert.match((await core.action({ action: 'verifyPin', date: DATE, pin: '654321' })).error, /No PIN issued/);
  gas.hashes.pin = await sha256Hex('654321');
  core.tick(20000);
  assert.equal((await core.action({ action: 'verifyPin', date: DATE, pin: '654321' })).ok, true);
});

test('actions made while a batch is in flight are kept on top of its snapshot', async () => {
  const gas = fakeGas();
  const core = makeCore(gas);
  await core.action({ action: 'checkin', date: DATE, name: 'Player 01', ...ADMIN });
  let release;
  gas.delay = () => new Promise((res) => { release = res; });
  const flushing = core.alarm();
  await new Promise((r) => setTimeout(r, 5));
  await core.action({ action: 'checkin', date: DATE, name: 'Player 02', ...ADMIN });
  gas.delay = null;
  release();
  await flushing;
  let w = await core.week();
  assert.equal(w.signups[0].checkedIn, true);
  assert.equal(w.signups[1].checkedIn, true, 'second check-in still shown');
  assert.equal(gas.truth.signups[1].checkedIn, false);
  await core.alarm();
  assert.equal(gas.truth.signups[1].checkedIn, true);
  w = await core.week();
  assert.equal(w.sync.pending, 0);
});

test('the singles match desk end to end, with timers kept from the first tap', async () => {
  const gas = fakeGas();
  const core = makeCore(gas);
  for (const n of NAMES.slice(0, 24)) await core.action({ action: 'checkin', date: DATE, name: n, ...ADMIN });
  const gp = await core.action({ action: 'generatePools', date: DATE, padGuests: [], ...ADMIN });
  assert.deepEqual(gp.pools.map((p) => p.players.length), [6, 6, 6, 6]);
  const sm = await core.action({ action: 'startMatch', date: DATE, a: 'Player 01', b: 'Player 02', ...ADMIN });
  assert.equal(sm.ok, true);
  assert.ok(sm.match.id, 'match id minted when the site sends none');
  const startedAt = sm.match.startedAt;
  core.tick(60000);
  await core.alarm();
  let w = await core.week();
  assert.equal(w.live.matches[0].id, sm.match.id, 'sheet kept the same id');
  assert.equal(w.live.matches[0].startedAt, startedAt, 'timer kept from the first tap');
  const rs = await core.action({ action: 'recordScore', date: DATE, matchId: sm.match.id, scoreA: 21, scoreB: 17, ...ADMIN });
  assert.equal(rs.ok, true);
  await core.alarm();
  w = await core.week();
  assert.equal(w.pools[0].grid[0][1], 21);
  assert.equal(w.pools[0].grid[1][0], 17);
  assert.equal(gas.truth.grids.A[0][1], 21);
});

test('a refusal from the sheet is recorded and the board corrects itself', async () => {
  const gas = fakeGas();
  const core = makeCore(gas);
  gas.refuse = (op) => op.action === 'noshow';
  await core.action({ action: 'noshow', date: DATE, name: 'Player 03', ...ADMIN });
  assert.equal((await core.week()).signups[2].noShow, true);
  await core.alarm();
  const w = await core.week();
  assert.equal(w.signups[2].noShow, false, 'sheet wins');
  assert.equal(w.sync.conflicts.length, 1);
  assert.match(w.sync.conflicts[0].op, /noshow \(Player 03\)/);
});

test('Apps Script down: the action still answers, retries back off, then catch up', async () => {
  const gas = fakeGas();
  const core = makeCore(gas);
  await core.week(); // loaded
  gas.fail = 2;
  await core.action({ action: 'checkin', date: DATE, name: 'Player 09', ...ADMIN });
  await core.alarm();
  let w = await core.week();
  assert.match(w.sync.error, /network down/);
  assert.equal(w.sync.pending, 1);
  assert.ok(core.storageRef.alarmAt() > 1000000, 'retry scheduled');
  await core.alarm();
  await core.alarm();
  w = await core.week();
  assert.equal(w.sync.error, null);
  assert.equal(w.sync.pending, 0);
  assert.equal(gas.truth.signups[8].checkedIn, true);
});

test('doubles: quick successive team saves never trip the rev check, before or after a sync', async () => {
  const gas = fakeGas({ relay: true });
  const core = makeCore(gas);
  const d = await core.action({ action: 'drawTeams', date: DATE, teamCount: 4, ...ADMIN });
  assert.equal(d.ok, true);
  let rev = d.relay.rev;
  const teams = d.relay.teams;
  // swap the first two players of team A, twice, saving with each reply's rev
  for (let i = 0; i < 2; i++) {
    [teams[0].players[0], teams[0].players[1]] = [teams[0].players[1], teams[0].players[0]];
    const r = await core.action({ action: 'relaySaveTeams', date: DATE, teams, guests: [], rev, ...ADMIN });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.relay.rev > rev);
    rev = r.relay.rev;
    if (i === 0) await core.alarm(); // a sync lands between the two saves
  }
  const stale = await core.action({ action: 'relaySaveTeams', date: DATE, teams, guests: [], rev: rev - 1, ...ADMIN });
  assert.equal(stale.stale, true, 'an old rev is still refused');
  await core.alarm();
  const w = await core.week();
  assert.equal(w.relay.rev >= rev, true, 'rev never goes backwards');
  assert.deepEqual(w.relay.teams[0].players, gas.truth.relay.teams[0].players);
  const g = await core.action({ action: 'relayStartGame', date: DATE, tie: 0, round: 1, seq: 0, ...ADMIN });
  assert.equal(g.ok, true, g.error);
  const s = await core.action({ action: 'relayScore', date: DATE, tie: 0, round: 1, seq: 0, scoreA: 21, scoreB: 12, ...ADMIN });
  assert.equal(s.ok, true);
  await core.alarm();
  assert.equal(gas.truth.relay.games[0].sa, 21);
  assert.equal((await core.week()).relay.games[0].sb, 12);
});

test('reload from the sheet picks up a hand edit', async () => {
  const gas = fakeGas();
  const core = makeCore(gas);
  await core.week();
  gas.truth.signups[0].name = 'Player 01 Renamed';
  assert.equal((await core.action({ action: 'syncReload', date: DATE, secret: 'nope' })).ok, false);
  const r = await core.action({ action: 'syncReload', date: DATE, ...ADMIN });
  assert.equal(r.ok, true);
  assert.equal(r.week.signups[0].name, 'Player 01 Renamed');
});

test('admin passthrough waits for queued actions to reach the sheet first', async () => {
  const gas = fakeGas();
  const core = makeCore(gas);
  await core.action({ action: 'checkin', date: DATE, name: 'Player 11', ...ADMIN });
  const r = await core.passthrough({ action: 'resetWeek', date: DATE, secret: 'pass' });
  assert.equal(r.passthrough, 'resetWeek');
  const order = gas.calls.map((c) => c.action);
  assert.ok(order.indexOf('syncBatch') < order.indexOf('resetWeek'));
});

test('an idle copy re-reads the sheet in the background after 10 minutes', async () => {
  const gas = fakeGas();
  const core = makeCore(gas);
  await core.week();
  gas.truth.signups[1].name = 'Changed In Sheet';
  core.tick(11 * 60 * 1000);
  const stale = await core.week();
  assert.equal(stale.signups[1].name, 'Player 02', 'served instantly from the copy');
  await core.alarm();
  assert.equal((await core.week()).signups[1].name, 'Changed In Sheet');
});

test('engine replies are fast enough for the Workers free plan (10 ms CPU)', async () => {
  const gas = fakeGas({ relay: true });
  const core = makeCore(gas);
  for (const n of NAMES) await core.action({ action: 'join', date: DATE, name: n + 'x' });
  await core.action({ action: 'drawTeams', date: DATE, teamCount: 6, ...ADMIN });
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) await core.week();
  const t1 = performance.now();
  await core.action({ action: 'relayStartGame', date: DATE, tie: 0, round: 1, seq: 0, ...ADMIN });
  const t2 = performance.now();
  assert.ok((t1 - t0) / 20 < 10, 'week() ' + ((t1 - t0) / 20).toFixed(2) + 'ms');
  assert.ok(t2 - t1 < 10, 'relayStartGame ' + (t2 - t1).toFixed(2) + 'ms');
});

test('meta cache: serves stale data at once and refreshes in the background', async () => {
  const storage = memStorage();
  let t = 0, version = 1;
  const meta = new MetaCore({ storage, now: () => t, gasGet: async (q) => ({ q, version }) });
  assert.equal((await meta.get('rankings')).version, 1);
  version = 2;
  assert.equal((await meta.get('rankings')).version, 1, 'fresh enough');
  t += 6 * 60 * 1000;
  assert.equal((await meta.get('rankings')).version, 1, 'stale copy served at once');
  await meta.alarm();
  assert.equal((await meta.get('rankings')).version, 2);
  version = 3;
  await meta.invalidate(['rankings']);
  await meta.alarm();
  assert.equal((await meta.get('rankings')).version, 3);
  assert.equal((await meta.get('headtohead', 'Player 01')).q, 'action=headtohead&name=Player%2001');
});

test('a failed first load is not retried for a minute, so the fallback stays quick', async () => {
  const gas = fakeGas();
  const core = makeCore(gas);
  gas.fail = 1;
  await assert.rejects(core.week(), /network down/);
  const calls = gas.calls.length;
  await assert.rejects(core.week(), /network down/);
  await assert.rejects(core.action({ action: 'join', date: DATE, name: 'Someone' }), /network down/);
  assert.equal(gas.calls.length, calls, 'no new Apps Script call within the minute');
  core.tick(61000);
  const w = await core.week();
  assert.equal(w.exists, true, 'loads again after a minute');
  assert.equal(w.sync.pending, 0);
});
