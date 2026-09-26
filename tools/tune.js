// Suggests costs (and download sizes) so each update takes roughly a target number of
// seconds to afford and to download, assuming updates are bought in list order.
// Prints "id cost reveal size rate". Early and special updates keep their hand-set values.
require('../updates.js');
const { UPDATES, computeStats } = globalThis.GameData;
const TAPS = 3;
const FIXED = new Set(['b101', 'u110', 'b102', 'b110', 'c20', 'b111', 'b120', 'b251', 'b261']);
const FIXED_SIZE = new Set([...FIXED, 'b710', 'os150']);
const installed = new Set();
const nice = x => { const e = Math.pow(10, Math.floor(Math.log10(x)) - 1); return Math.round(x / e) * e; };
let lastMain = 0;
UPDATES.forEach((u, i) => {
  const s = computeStats(installed);
  const f = i / UPDATES.length;
  const cap = s.buttons / s.cooldown;
  const presses = Math.min(cap, TAPS + s.fingers / s.interval) + s.cloud;
  const rate = presses * s.perPress * s.critEV;
  const gap = u.joke ? 8 : u.id === 'os150' ? 150 : (28 + 32 * f) * (u.app === 'button' ? 1 : 0.7);
  let { cost, reveal, size } = u;
  if (!FIXED.has(u.id)) {
    cost = nice(rate * gap);
    reveal = u.joke ? lastMain : Math.round(cost * 0.6);
  }
  if (!FIXED_SIZE.has(u.id)) {
    const secs = u.joke ? 1.5 : u.app === 'carrier' ? 2 : u.app === 'os' ? 25 : 6 + 10 * f;
    size = nice(secs * s.speed / s.sizeMult);
  }
  if (!u.joke && cost) lastMain = cost;
  console.log(u.id, cost, reveal, size, rate.toFixed(1));
  installed.add(u.id);
});
