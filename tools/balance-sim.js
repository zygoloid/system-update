// Rough balance simulator: plays the game with a simple "reasonable player" model
// and prints when each update gets installed.
//
//   node tools/balance-sim.js [tapsPerSecond]

require('../updates.js');
const { UPDATES, byId, computeStats } = globalThis.GameData;

const TAPS = Number(process.argv[2] || 4);   // sustained manual taps per second
const REACT = 2;                              // seconds lost switching apps for a manual action
const dt = 0.05;

const installed = new Set();
let s = computeStats(installed);
let t = 0, clicks = 0, total = 0, busy = 0;
const dl = {};           // id -> {mb, prep, st}
const iq = [];
let installLeft = 0;
const log = [];

const rate = () => (Math.min(TAPS, s.buttons / s.cooldown) + Math.min(s.fingers / s.interval, Math.max(0, s.buttons / s.cooldown - TAPS)) + s.cloud) * s.perPress * s.critEV;
const size = u => u.size * s.sizeMult;
const revealed = u => !installed.has(u.id) && !dl[u.id] && total >= u.reveal && u.req.every(r => installed.has(r));

while (t < 4 * 3600 && !installed.has('os150')) {
  // Player decisions
  for (const u of UPDATES) {
    if (!revealed(u) || clicks < u.cost) continue;
    if (u.manual && busy > 0) continue;
    clicks -= u.cost;
    dl[u.id] = { mb: 0, prep: u.prep || 0, st: 'queued' };
    if (!s.autoDl) busy += REACT;
  }
  const active = Object.values(dl).filter(e => e.st === 'dl').length;
  let slots = s.parallel - active;
  for (const id in dl) if (slots > 0 && dl[id].st === 'queued') { dl[id].st = 'dl'; slots--; }

  // Downloads
  const anyDl = Object.values(dl).some(e => e.st === 'dl');
  const watching = !s.bgDl && anyDl;   // player has to sit in Update Manager
  for (const id in dl) {
    const e = dl[id], u = byId[id];
    if (e.st !== 'dl') continue;
    if (e.mb < size(u)) e.mb += s.speed * dt;
    else if (e.prep > 0) e.prep -= dt;
    else { e.st = 'done'; iq.push(id); if (!s.autoInst || u.app === 'os') busy += REACT; }
  }

  // Installs
  let blocked = false;
  if (iq.length) {
    const u = byId[iq[0]];
    if (installLeft <= 0) installLeft = u.boot || s.installTime * (u.app === 'carrier' ? 0.5 : 1);
    installLeft -= dt;
    if (u.app === 'button' || u.app === 'os') blocked = true;
    if (installLeft <= 0) {
      installed.add(u.id); delete dl[u.id]; iq.shift();
      s = computeStats(installed);
      if (u.event === 'apology') clicks += 2000;
      log.push([t, u, rate(), size(u) / s.speed]);
      installLeft = 0;
    }
  }

  // Pressing
  const cap = s.buttons / s.cooldown;
  let manual = (!blocked && !watching && busy <= 0) ? Math.min(TAPS, cap) : 0;
  let auto = blocked ? 0 : Math.min(s.fingers / s.interval, cap - manual);
  const crit = byId.b251 && revealed(byId.b251);
  if (crit) { manual = 0; auto = 0; }
  const gain = (manual + auto + s.cloud) * s.perPress * s.critEV * dt;
  clicks += gain; total += gain;
  if (busy > 0) busy -= dt;
  t += dt;
}

const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0);
const mmss = x => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
let prev = 0;
for (const [time, u, r, d] of log) {
  console.log(`${mmss(time).padStart(6)} (+${(time - prev).toFixed(0).padStart(4)}s)  ${u.id.padEnd(7)} ${(u.app + ' ' + u.ver).padEnd(16)} cost ${fmt(u.cost).padStart(7)}  dl ${d.toFixed(1).padStart(5)}s  rate→ ${fmt(r)}/s`);
  prev = time;
}
console.log(`\nInstalled ${log.length}/${UPDATES.length} in ${mmss(t)}; final rate ≈ ${fmt(rate())}/s`);
