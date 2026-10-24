/**
 * Pure team-doubles ("relay") rules, shared by the page (site/index.html),
 * the ?mock=1 sandbox (site/mock-backend.js / site/week-engine.js) and the
 * Cloudflare Worker (worker/), which imports this file as a module.
 *
 * Every function here mirrors the same-named one in gas/Code.gs - keep the
 * two copies in sync (Code.gs can't load this file).
 *
 * Loaded as a classic <script> it defines globals; required/imported it
 * exports them (see the bottom of the file).
 */
function playerKey(n){ return (n||'').trim().toLowerCase(); }
const RELAY_ROUNDS = 2;
const RELAY_TIEBREAK_ROUND = 3;
// Guests: unnamed "Guest 3" placeholders or names added as guests
// (state.guests) - no signup, no check-in, no rank points (Code.gs isRelayGuest).
function isRelayGuest(n, state){
  if(/^guest\b/i.test((n||'').trim())) return true;
  return !!(state && state.guests && state.guests.some(g=>playerKey(g)===playerKey(n)));
}
// A team's fixed doubles pairs for the night: P1+P2, P3+P4, ... (Code.gs
// relayPairs). An odd player out isn't paired - the team needs a guest.
function relayPairs(players){
  const out = [];
  for(let i=0; i+1<players.length; i+=2) out.push([players[i], players[i+1]]);
  return out;
}
// Fixed playing orders by pairs per team and round - 'a' for the first team
// of a matchup, 'b' for the second; game k is a[k] vs b[k]. Round 2 is used
// when neither team re-paired and brings in the match-ups round 1
// didn't have (Code.gs RELAY_ORDERS / relayFixedOrder).
const RELAY_ORDERS = {
  1: {1: {a:[0,0], b:[0,0]}, 2: {a:[0,0], b:[0,0]}},
  2: {1: {a:[0,1,0,1], b:[0,1,1,0]}, 2: {a:[0,1,0,1], b:[0,1,1,0]}},
  3: {1: {a:[0,1,0,2,1,2], b:[0,1,2,0,2,1]}, 2: {a:[0,1,2,1,0,2], b:[0,2,1,0,1,2]}},
  4: {1: {a:[0,1,2,0,3,2,1,3], b:[0,1,2,3,0,1,2,3]}, 2: {a:[0,2,1,0,3,1,2,3], b:[1,0,3,2,1,0,3,2]}},
  5: {1: {a:[0,1,2,3,0,4,1,2,3,4], b:[0,1,2,3,4,0,2,1,4,3]}, 2: {a:[0,1,2,3,0,4,1,3,2,4], b:[2,0,4,1,3,2,4,0,3,1]}}
};
function relayFixedOrder(n, round, side){
  const t = RELAY_ORDERS[n];
  if(t) return (side ? t[round].b : t[round].a).slice();
  const shifts = round === 2 ? [3, 1] : [0, 2];
  const out = [];
  for(let pass=0; pass<2; pass++) for(let j=0; j<n; j++) out.push(side ? (j+shifts[pass])%n : j);
  return out;
}
// Positions P1..Pn for a round: the team list for round 1, the team's
// round-2 positions (lineup2) for round 2 when set - reconciled with the roster.
function relayLineup(team, round){
  const players = team.players || [];
  if(round !== 2 || !Array.isArray(team.lineup2)) return players.slice();
  const byKey = {}, used = new Set(), out = [];
  players.forEach(p=>{ byKey[playerKey(p)] = p; });
  team.lineup2.forEach(n=>{ const k = playerKey(n); if(byKey[k] && !used.has(k)){ out.push(byKey[k]); used.add(k); } });
  players.forEach(p=>{ if(!used.has(playerKey(p))) out.push(p); });
  return out;
}
function relaySamePairs(team){
  const keys = lineup=>relayPairs(lineup).map(pr=>pr.map(p=>p.toLowerCase()).sort().join('+')).sort().join('|');
  return keys(relayLineup(team, 1)) === keys(relayLineup(team, 2));
}
// A round's games: [[aPair, bPair], ...] (Code.gs relaySchedule). played =
// round 1's games, for fitting re-paired round-2 pairs.
function relaySchedule(ta, tb, round, played){
  const repeat = round === 2 && relaySamePairs(ta) && relaySamePairs(tb);
  const pa = relayPairs(relayLineup(ta, repeat ? 1 : round)), pb = relayPairs(relayLineup(tb, repeat ? 1 : round));
  const n = Math.max(pa.length, pb.length);
  if(!n) return [];
  if(round === 2 && !repeat) return relayRepairSchedule(pa, pb, played || relaySchedule(ta, tb, 1));
  const oa = relayFixedOrder(n, repeat ? 2 : 1, 0), ob = relayFixedOrder(n, repeat ? 2 : 1, 1);
  return oa.map((x,k)=>[pa[x] || null, pb[ob[k]] || null]);
}
// Every ordering of 0..n-1, identity first; past 5 just the identity
// (Code.gs relayPerms).
function relayPerms(n){
  const id = [...Array(n).keys()];
  if(n > 5) return [id];
  const out = [];
  const rec = (cur, left)=>{
    if(!left.length){ out.push(cur); return; }
    left.forEach((x,i)=>rec(cur.concat([x]), left.slice(0,i).concat(left.slice(i+1))));
  };
  rec([], id);
  return out;
}
// Round 2 after a re-pair: a fixed order with each side's pairs relabelled
// so they meet the fewest round-1 opponents, then so nobody from round 1's
// last game opens round 2 (Code.gs relayRepairSchedule - keep identical).
function relayRepairSchedule(pa, pb, played){
  const n = Math.max(pa.length, pb.length);
  const meets = {};
  (played||[]).forEach(g=>(g[0]||[]).forEach(x=>(g[1]||[]).forEach(y=>{
    const k = playerKey(x)+'|'+playerKey(y); meets[k] = (meets[k]||0) + 1;
  })));
  const cost = [];
  for(let i=0; i<n; i++){
    cost.push([]);
    for(let j=0; j<n; j++){
      let c = 0;
      (pa[i]||[]).forEach(x=>(pb[j]||[]).forEach(y=>{ c += meets[playerKey(x)+'|'+playerKey(y)] || 0; }));
      cost[i].push(c);
    }
  }
  const lastGame = played && played.length ? played[played.length-1] : null;
  const tired = new Set(lastGame ? (lastGame[0]||[]).concat(lastGame[1]||[]).map(playerKey) : []);
  const opensTired = pr=>(pr||[]).some(x=>tired.has(playerKey(x))) ? 1 : 0;
  const perms = relayPerms(n);
  let best = null;
  search:
  for(let tpl=1; tpl<=2; tpl++){
    const oa = relayFixedOrder(n, tpl, 0), ob = relayFixedOrder(n, tpl, 1);
    for(const ra of perms){
      for(const rb of perms){
        let total = 0;
        for(let k=0; k<oa.length && (!best || total <= best.total); k++) total += cost[ra[oa[k]]][rb[ob[k]]];
        if(best && total > best.total) continue;
        const rest = opensTired(pa[ra[oa[0]]]) + opensTired(pb[rb[ob[0]]]);
        if(best && total === best.total && rest >= best.rest) continue;
        best = {total, rest, oa, ob, ra, rb};
        if(!total && !rest) break search;
      }
    }
  }
  return best.oa.map((x,k)=>[pa[best.ra[x]] || null, pb[best.rb[best.ob[k]]] || null]);
}
// Why a matchup can't start games yet ('' when it can) - Code.gs relayMatchupProblem.
function relayMatchupProblem(ta, tb){
  const odd = [ta, tb].filter(t=>t.players.length % 2);
  if(odd.length) return `Team ${odd.map(t=>t.id).join(' and Team ')} ${odd.length>1?'have':'has'} an odd number of players — add a guest (or a late player) so everyone has a partner.`;
  if(ta.players.length !== tb.players.length) return `Team ${ta.id} has ${ta.players.length} players and Team ${tb.id} has ${tb.players.length} — even them out with a guest or a late player.`;
  return '';
}
// Partner requests -> disjoint pairs from `names` (Code.gs relayRequestPairs):
// mutual requests first, then one-way ones whose partner asked for no one else
// and didn't pick "Mix me in".
function relayRequestPairs(requests, names){
  const byKey = {};
  names.forEach(n=>{ byKey[playerKey(n)] = n; });
  const want = {}, mix = {};
  (requests||[]).forEach(r=>{
    const a = playerKey(r.name), b = playerKey(r.partner);
    if(a && r.mix) mix[a] = true;
    if(a && b && a!==b && byKey[a] && byKey[b]) want[a] = b;
  });
  const used = {}, out = [];
  [true, false].forEach(mutualPass=>names.forEach(n=>{
    const a = playerKey(n), b = want[a];
    if(!b || used[a] || used[b]) return;
    if(mutualPass ? want[b]!==a : !!want[b] || mix[b]) return;
    used[a] = used[b] = true;
    out.push([byKey[a], byKey[b]]);
  }));
  return out;
}
// The draw's team lists (Code.gs relayDrawTeams): requested pairs claim
// spots in their stronger player's tier, everyone else fills the rest in
// standings order; then each tier is drafted in standings order, the next
// pick going to the team with fewer players (A on a tie), a pair counting
// as two picks.
function relayDrawTeams(names, sizes, pairs){
  const pos = {};
  names.forEach((n,i)=>{ pos[playerKey(n)] = i; });
  const tiers = Math.floor(sizes.length/2);
  const paired = sizes.map(()=>[]), singles = sizes.map(()=>[]), units = [], room = [], pairRoom = [];
  for(let m=0; m<tiers; m++){
    room.push(sizes[2*m] + sizes[2*m+1]);
    pairRoom.push(Math.floor(sizes[2*m]/2) + Math.floor(sizes[2*m+1]/2));
    units.push([]);
  }
  const tierOf = p=>{
    let start = 0;
    for(let m=0; m<tiers; m++){ start += sizes[2*m] + sizes[2*m+1]; if(p < start) return m; }
    return tiers-1;
  };
  const placed = {};
  (pairs||[]).map(pr=>{
    const s = pr.slice().sort((x,y)=>pos[playerKey(x)]-pos[playerKey(y)]);
    return {pr: s, top: pos[playerKey(s[0])]};
  }).sort((x,y)=>x.top-y.top).forEach(u=>{
    const home = tierOf(u.top), order = [];
    for(let d=home; d<tiers; d++) order.push(d);
    for(let up=home-1; up>=0; up--) order.push(up);
    const tier = order.find(t=>pairRoom[t] >= 1);
    if(tier === undefined) return;
    units[tier].push({players: u.pr, top: u.top});
    pairRoom[tier]--;
    room[tier] -= 2;
    placed[playerKey(u.pr[0])] = placed[playerKey(u.pr[1])] = true;
  });
  let tierNow = 0;
  names.forEach((n,i)=>{
    if(placed[playerKey(n)]) return;
    while(tierNow < tiers-1 && room[tierNow] <= 0) tierNow++;
    units[tierNow].push({players: [n], top: i});
    room[tierNow]--;
  });
  units.forEach((list, m)=>{
    const left = [sizes[2*m], sizes[2*m+1]], picks = [0, 0];
    let pairsLeft = list.filter(u=>u.players.length===2).length;
    list.sort((x,y)=>x.top-y.top).forEach(u=>{
      const n = u.players.length;
      // A single mustn't take the spot a later pair needs.
      const fits = s=>{
        if(left[s] < n) return false;
        if(n === 2) return true;
        const l = left.slice(); l[s]--;
        return Math.floor(l[0]/2) + Math.floor(l[1]/2) >= pairsLeft;
      };
      const first = picks[1] < picks[0] ? 1 : 0;
      const side = fits(first) ? first : 1-first;
      (n === 2 ? paired : singles)[2*m+side].push(...u.players);
      left[side] -= n;
      picks[side] += n;
      if(n === 2) pairsLeft--;
    });
  });
  return paired.map((p,i)=>p.concat(singles[i]));
}
// Makes a and b one pair on the same team by swapping players (team sizes
// never change), picking the swap whose cross-team trade is closest in
// standings (seedOf; lower = stronger) and never moving anyone in `locked`
// (Code.gs relayPairUp).
function relayPairUp(teams, a, b, locked, seedOf){
  const seed = n=>{ const v = seedOf ? seedOf(n) : 0; return typeof v==='number' && isFinite(v) ? v : 9999; };
  const find = n=>{
    for(let ti=0; ti<teams.length; ti++){
      const pi = teams[ti].players.findIndex(p=>playerKey(p)===playerKey(n));
      if(pi>=0) return [ti, pi];
    }
    return null;
  };
  const swap = (p, q)=>{
    const t = teams[p[0]].players[p[1]];
    teams[p[0]].players[p[1]] = teams[q[0]].players[q[1]];
    teams[q[0]].players[q[1]] = t;
  };
  const paired = ()=>{ const pa = find(a), pb = find(b); return !!pa && !!pb && pa[0]===pb[0] && (pa[1]^1)===pb[1]; };
  if(!find(a) || !find(b)) return false;
  if(paired()) return true;
  let best = null;
  [[a, b], [b, a]].forEach(([x, y])=>{
    const px = find(x), py = find(y), team = teams[px[0]].players;
    const free = n=>playerKey(n)===playerKey(x) || playerKey(n)===playerKey(y) || !locked[playerKey(n)];
    for(let k=0; k<Math.floor(team.length/2); k++){
      const s0 = 2*k, s1 = s0+1;
      if(!free(team[s0]) || !free(team[s1])) continue;
      [s1, s0].forEach(sd=>{
        const d = team[sd];
        if(playerKey(d)===playerKey(x)) return;
        const cost = (playerKey(d)===playerKey(y) || py[0]===px[0]) ? 0 : Math.abs(seed(d) - seed(y));
        if(!best || cost < best.cost) best = {cost, x, y, team: px[0], xSlot: s0+s1-sd, sd};
      });
    }
  });
  if(!best) return false;
  swap(find(best.x), [best.team, best.xSlot]);
  if(playerKey(teams[best.team].players[best.sd])!==playerKey(best.y)) swap(find(best.y), [best.team, best.sd]);
  return paired();
}
// Which of `names` are on court right now (Code.gs relayOnCourt).
function relayOnCourt(state, names){
  const busy = new Set();
  state.games.forEach(g=>{ if(g.startedAt && !relayGameDone(g)) (g.a||[]).concat(g.b||[]).forEach(n=>busy.add(playerKey(n))); });
  return names.filter(n=>busy.has(playerKey(n)));
}
function relayTieCount(state){ return Math.floor(state.teams.length/2); }
function relayFindGame(state, tie, round, seq){
  return state.games.find(g=>g.tie===tie && g.round===round && g.seq===seq) || null;
}
function relayGameDone(g){ return !!g && typeof g.sa==='number' && typeof g.sb==='number'; }
function relayTieView(state, tie){
  const ta = state.teams[2*tie], tb = state.teams[2*tie+1];
  const problem = relayMatchupProblem(ta, tb);
  const rounds = [];
  let played = null; // round 1's games, for fitting re-paired round-2 pairs
  for(let r=1; r<=RELAY_ROUNDS; r++){
    const sched = relaySchedule(ta, tb, r, played);
    let count = sched.length;
    state.games.forEach(g=>{ if(g.tie===tie && g.round===r && g.seq+1 > count) count = g.seq+1; });
    const games = [];
    let winsA=0, winsB=0, ptsA=0, ptsB=0, doneCount=0;
    for(let s=0; s<count; s++){
      const rec = relayFindGame(state, tie, r, s);
      const g = {
        seq: s,
        a: rec ? rec.a : (s < sched.length ? sched[s][0] : null),
        b: rec ? rec.b : (s < sched.length ? sched[s][1] : null),
        startedAt: rec ? rec.startedAt || null : null,
        done: relayGameDone(rec)
      };
      if(g.done){
        g.sa = rec.sa; g.sb = rec.sb;
        doneCount++; ptsA += rec.sa; ptsB += rec.sb;
        if(rec.sa > rec.sb) winsA++; else winsB++;
      }
      games.push(g);
    }
    const done = count > 0 && doneCount === count;
    let winner = null;
    if(done){
      if(winsA !== winsB) winner = winsA > winsB ? 'a' : 'b';
      else if(ptsA !== ptsB) winner = ptsA > ptsB ? 'a' : 'b';
      else winner = 'draw';
    }
    if(r === 1) played = games.map(x=>[x.a, x.b]);
    rounds.push({round:r, games, done, started: doneCount>0 || games.some(x=>!!x.startedAt), winsA, winsB, ptsA, ptsB, winner});
  }
  const allDone = rounds.every(x=>x.done);
  const roundsA = rounds.filter(x=>x.winner==='a').length, roundsB = rounds.filter(x=>x.winner==='b').length;
  const needsTiebreak = allDone && roundsA === roundsB;
  const tbRec = relayFindGame(state, tie, RELAY_TIEBREAK_ROUND, 0);
  const tiebreak = tbRec ? {seq:0, a:tbRec.a, b:tbRec.b, startedAt:tbRec.startedAt||null, done:relayGameDone(tbRec), sa:tbRec.sa, sb:tbRec.sb} : null;
  let winner = null;
  if(allDone){
    if(roundsA !== roundsB) winner = roundsA > roundsB ? 'a' : 'b';
    else if(tiebreak && tiebreak.done) winner = tiebreak.sa > tiebreak.sb ? 'a' : 'b';
  }
  return {tie, a:ta, b:tb, problem, rounds, roundsA, roundsB, needsTiebreak, tiebreak, winner, done: !!winner};
}
function relayPlayerStats(state, bonus){
  const byKey = {}, teamOf = {}, tieWinner = {};
  state.teams.forEach(t=>t.players.forEach(p=>{ teamOf[playerKey(p)] = t.id; }));
  for(let tie=0; tie<relayTieCount(state); tie++){
    const v = relayTieView(state, tie);
    if(v.winner) tieWinner[v.winner==='a' ? v.a.id : v.b.id] = true;
  }
  const entry = name=>{
    const k = playerKey(name);
    if(!byKey[k]) byKey[k] = {name:name.trim(), team:teamOf[k]||'', played:0, won:0, guest:isRelayGuest(name, state)};
    return byKey[k];
  };
  state.teams.forEach(t=>t.players.forEach(entry));
  state.games.forEach(g=>{
    if(g.round > RELAY_ROUNDS || !relayGameDone(g)) return;
    const teamA = state.teams[2*g.tie], teamB = state.teams[2*g.tie+1];
    [[g.a, g.sa>g.sb, teamA], [g.b, g.sb>g.sa, teamB]].forEach(([pair, won, team])=>{
      (pair||[]).forEach(n=>{
        const e = entry(n);
        e.played++;
        if(won) e.won++;
        if(!e.team && team) e.team = team.id;
      });
    });
  });
  return Object.values(byKey).map(e=>{
    e.teamWon = !!(e.team && tieWinner[e.team]);
    e.rp = e.won + (e.teamWon ? bonus : 0);
    return e;
  }).sort((x,y)=>y.rp-x.rp || y.won-x.won || x.name.localeCompare(y.name));
}

// The draw's team sizes (Code.gs relayTeamSizes): every team an even number
// of spots, both teams of a matchup the same, extra pairs to the top
// matchups, and the 0-3 leftover spots as guests on the last teams.
// {sizes: real players per team, guests: guests per team}.
function relayTeamSizes(n, k){
  const m = Math.floor(k/2);
  const pairsPerSide = Math.ceil(n/4);
  const base = Math.floor(pairsPerSide/m), extra = pairsPerSide - base*m;
  const spots = Array.from({length:k}, (_,t)=>2*(base + (Math.floor(t/2) < extra ? 1 : 0)));
  const guests = Array(k).fill(0);
  let left = 4*pairsPerSide - n;
  for(let g=k-1; left>0 && g>=0; g--, left--) guests[g] = 1;
  return {sizes: spots.map((sp,i)=>sp-guests[i]), guests};
}
function relayDefaultTeamCount(n, counts){
  let best = counts[0];
  counts.forEach(c=>{ if(Math.abs(n/c-6) < Math.abs(n/best-6)) best = c; });
  return best;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { playerKey, RELAY_ROUNDS, RELAY_TIEBREAK_ROUND, RELAY_ORDERS, isRelayGuest, relayPairs, relayFixedOrder, relayLineup, relaySamePairs, relaySchedule, relayPerms, relayRepairSchedule, relayMatchupProblem, relayRequestPairs, relayDrawTeams, relayPairUp, relayOnCourt, relayTieCount, relayFindGame, relayGameDone, relayTieView, relayPlayerStats, relayTeamSizes, relayDefaultTeamCount };
}
