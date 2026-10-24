// Season-wide read cache (the MetaDO Durable Object in src/index.js): the
// standings, the list of event dates, and head-to-head lookups, which only
// change when a week is finalized, a week tab is created, or a player is
// renamed. Served from storage and refreshed from Apps Script in the
// background once older than its TTL (stale-while-revalidate), or right away
// when the Worker knows it changed (invalidate). Free of Cloudflare APIs so
// test/ can run it in Node.

const TTL_MS = {
  rankings: 5 * 60 * 1000,
  weekDates: 5 * 60 * 1000,
  headtohead: 10 * 60 * 1000
};
const H2H_KEPT = 80; // head-to-head entries kept (one per player looked up)

export class MetaCore {
  // storage: {get, put, delete, list?, getAlarm, setAlarm}; gasGet(query) ->
  // JSON from Code.gs's doGet.
  constructor({ storage, gasGet, now }) {
    this.storage = storage;
    this.gasGet = gasGet;
    this.now = now || (() => Date.now());
    this.pending = {};
  }

  static queryFor(kind, name) {
    if (kind === 'headtohead') return 'action=headtohead&name=' + encodeURIComponent(name || '');
    return 'action=' + kind;
  }

  async fetchFresh(kind, name) {
    const id = kind + ':' + (name || '').trim().toLowerCase();
    if (!this.pending[id]) {
      this.pending[id] = (async () => {
        const data = await this.gasGet(MetaCore.queryFor(kind, name));
        if (!data || data.error) throw new Error((data && data.error) || 'Apps Script read failed');
        await this.storage.put(id, { at: this.now(), data });
        if (kind === 'headtohead') await this.trimHeadToHead(id);
        return data;
      })().finally(() => { delete this.pending[id]; });
    }
    return this.pending[id];
  }

  async trimHeadToHead(justAdded) {
    const index = (await this.storage.get('h2h-index')) || [];
    const next = index.filter((k) => k !== justAdded).concat([justAdded]);
    while (next.length > H2H_KEPT) await this.storage.delete(next.shift());
    await this.storage.put('h2h-index', next);
  }

  // Returns the cached copy when there is one (refreshing it in the
  // background once stale); otherwise waits for Apps Script.
  async get(kind, name) {
    const id = kind + ':' + (name || '').trim().toLowerCase();
    const hit = await this.storage.get(id);
    if (hit) {
      const stale = this.now() - hit.at > TTL_MS[kind] || hit.stale;
      if (stale && kind === 'headtohead') {
        try { return await this.fetchFresh(kind, name); } catch (err) { return hit.data; }
      }
      if (stale) {
        await this.storage.put('want:' + kind, true);
        await this.storage.setAlarm(this.now());
      }
      return hit.data;
    }
    return this.fetchFresh(kind, name);
  }

  // Marks the cache stale and refreshes it in the background.
  async invalidate(kinds) {
    for (const kind of kinds) {
      if (kind === 'headtohead') {
        const index = (await this.storage.get('h2h-index')) || [];
        for (const id of index) await this.storage.delete(id);
        await this.storage.put('h2h-index', []);
        continue;
      }
      const id = kind + ':';
      const hit = await this.storage.get(id);
      if (hit) await this.storage.put(id, Object.assign({}, hit, { stale: true }));
      await this.storage.put('want:' + kind, true);
    }
    await this.storage.setAlarm(this.now());
  }

  async alarm() {
    let failed = false;
    for (const kind of ['rankings', 'weekDates']) {
      if (!(await this.storage.get('want:' + kind))) continue;
      try {
        await this.fetchFresh(kind);
        await this.storage.delete('want:' + kind);
      } catch (err) {
        failed = true;
      }
    }
    if (failed) await this.storage.setAlarm(this.now() + 30000);
  }
}
