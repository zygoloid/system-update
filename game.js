(() => {
  'use strict';

  const { APPS, UPDATES, byId, computeStats, versionOf } = window.GameData;
  const SAVE_KEY = 'system-update/save/v1';
  const TICK = 0.05;
  const OFFLINE_CAP = 4 * 3600;

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rand = a => a[Math.floor(Math.random() * a.length)];

  // ───────────────────────── Formatting ─────────────────────────

  function fmt(n) {
    n = Math.floor(n);
    if (n < 1e4) return n.toLocaleString('en-US');
    const units = ['K', 'M', 'B', 'T', 'Qa', 'Qi'];
    let i = -1;
    while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
    return (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0)) + units[i];
  }
  function fmtRate(n) { return n < 10 ? n.toFixed(1) : fmt(n); }
  function fmtSize(mb) {
    if (mb < 1) return Math.max(1, Math.round(mb * 1000)) + ' KB';
    if (mb < 1000) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
    const gb = mb / 1000;
    if (gb < 1000) return (gb < 10 ? gb.toFixed(2) : gb < 100 ? gb.toFixed(1) : Math.round(gb)) + ' GB';
    return (gb / 1000).toFixed(1) + ' TB';
  }
  function fmtDur(s) {
    s = Math.max(0, Math.ceil(s));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }
  function clock(d = new Date()) {
    return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ───────────────────────── State ─────────────────────────

  function fresh() {
    return {
      v: 1, clicks: 0, total: 0, presses: 0, manual: 0,
      installed: [], dl: {}, iq: [], seen: {}, flags: {}, stopped: {},
      settings: { sound: true, banners: true, autoDl: true, autoInst: true },
      created: Date.now(), played: 0, last: Date.now(), ended: false,
    };
  }

  let S = fresh();
  let inst = new Set();
  let stats = computeStats(inst);

  // Runtime-only state (not saved)
  const rt = {
    fg: 'button', cd: [], wcd: 0, autoAcc: 0, held: new Map(), offsets: [],
    gains: [0], gainT: 0, rate: 0, quiet: false, quietLog: null,
    nq: [], bannerUntil: 0, dirty: true, fingerIdx: 0, adTimer: 12, ad: null,
    bubbleUntil: 0, lastSound: 0, labels: [], endTimer: null, expanded: new Set(), histOpen: new Set(),
  };

  function refreshStats() {
    inst = new Set(S.installed);
    stats = computeStats(inst);
    while (rt.cd.length < stats.buttons) rt.cd.push(0);
    rt.cd.length = stats.buttons;
    rt.dirty = true;
  }

  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || data.v !== 1) return false;
      S = Object.assign(fresh(), data);
      S.settings = Object.assign(fresh().settings, data.settings);
      S.installed = S.installed.filter(id => byId[id]);
      for (const id of Object.keys(S.dl)) if (!byId[id]) delete S.dl[id];
      S.iq = S.iq.filter(id => S.dl[id]);
      return true;
    } catch (e) { return false; }
  }

  function save() {
    S.last = Date.now();
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) { /* storage unavailable */ }
  }

  // ───────────────────────── Update status ─────────────────────────

  const verName = u => APPS[u.app].name + ' ' + u.ver;
  const sizeOf = u => u.size * stats.sizeMult;
  const reqMet = u => u.req.every(r => inst.has(r));

  function status(u) {
    if (inst.has(u.id)) return 'installed';
    const e = S.dl[u.id];
    if (e) return e.st;
    if (S.ended || !reqMet(u) || S.total < u.reveal) return 'locked';
    return 'available';
  }

  function criticalPending() {
    for (const u of UPDATES) if (u.critical && !inst.has(u.id) && reqMet(u)) return u;
    return null;
  }

  function currentInstall() {
    const id = S.iq[0];
    if (!id || !S.dl[id] || S.dl[id].st !== 'inst') return null;
    return byId[id];
  }

  function booting() {
    const u = currentInstall();
    return u && u.app === 'os';
  }

  function pressBlock() {
    if (S.ended) return 'incompatible';
    const cur = currentInstall();
    if (cur && (cur.app === 'button' || cur.app === 'os')) return 'installing';
    if (criticalPending()) return 'critical';
    if (S.flags.tos === 'pending') return 'tos';
    return null;
  }

  // ───────────────────────── Actions ─────────────────────────

  function buy(id, auto) {
    const u = byId[id];
    if (status(u) !== 'available' || S.clicks < u.cost) return false;
    S.clicks -= u.cost;
    S.dl[id] = { mb: 0, prep: u.prep || 0, st: 'queued' };
    if (!auto) delete S.stopped[id];
    pump();
    rt.dirty = true;
    if (!auto) sfx.tap();
    return true;
  }

  // Stopping a download throws away its progress and refunds the price. Automatic
  // Downloads leaves it alone until the player taps Get again.
  function stopDownload(id) {
    const e = S.dl[id];
    if (!e || !['queued', 'dl', 'prep'].includes(e.st)) return;
    delete S.dl[id];
    S.clicks += byId[id].cost;
    S.stopped[id] = 1;
    pump();
    rt.dirty = true;
    sfx.tap();
  }

  function pump() {
    let active = 0;
    for (const id in S.dl) if (S.dl[id].st === 'dl' || S.dl[id].st === 'prep') active++;
    for (const u of UPDATES) {
      if (active >= stats.parallel) break;
      const e = S.dl[u.id];
      if (e && e.st === 'queued') { e.st = 'dl'; active++; rt.dirty = true; }
    }
  }

  function queueInstall(id) {
    const e = S.dl[id];
    if (!e || e.st !== 'ready') return;
    e.st = 'iq';
    S.iq.push(id);
    rt.dirty = true;
  }

  function installDuration(u) {
    if (u.boot) return u.boot;
    return stats.installTime * (u.app === 'carrier' ? 0.5 : 1) * (u.joke ? 0.5 : 1);
  }

  function onDownloaded(u) {
    rt.dirty = true;
    if (stats.autoInst && S.settings.autoInst && !u.manual && u.app !== 'os') {
      queueInstall(u.id);
    } else {
      notify('updater', 'Ready to Install', `${verName(u)} has finished downloading.`, 'updates');
    }
  }

  function finishInstall(u) {
    S.installed.push(u.id);
    delete S.dl[u.id];
    S.iq.shift();
    refreshStats();
    if (u.event === 'apology') gain(2000);
    if (u.event === 'tos') S.flags.tos = 'pending';
    if (u.event === 'ending') {
      S.ended = true;
      S.flags.hello = true;
      S.flags.endTime = S.played;
    }
    if (u.app === 'os') {
      openApp('home', true);
      if (!u.event) notify('os', `Welcome to PhoneOS ${u.ver}`, u.notes[0], 'settings');
    } else {
      notify(u.app === 'button' ? 'button' : 'updater', `${APPS[u.app].name} Updated`,
        `${APPS[u.app].name} is now version ${u.ver}. ${u.notes[0]}`, u.app === 'button' ? 'button' : 'updates');
    }
    sfx.done();
    save();
  }

  function gain(v) {
    S.clicks += v;
    S.total += v;
    rt.gains[rt.gains.length - 1] += v;
  }

  function press(i, kind) {
    if (kind === 'widget') {
      if (rt.wcd > 0) return false;
      rt.wcd = stats.cooldown;
    } else {
      if (i >= rt.cd.length || rt.cd[i] > 0) return false;
      rt.cd[i] = stats.cooldown;
    }
    let v = stats.perPress;
    let lucky = false;
    if (stats.critChance && Math.random() < stats.critChance) { v *= stats.critMult; lucky = true; }
    gain(v);
    S.presses++;
    if (kind !== 'auto') S.manual++;
    if (!rt.quiet) view.onPress(i, v, lucky, kind);
    return true;
  }

  // ───────────────────────── Simulation step ─────────────────────────

  function step(dt, fg) {
    S.played += dt;

    // Installs run one at a time. Installing a PhoneOS update reboots the phone,
    // which pauses everything else.
    if (S.iq.length) {
      const id = S.iq[0];
      const e = S.dl[id];
      const u = byId[id];
      if (e.st !== 'inst') { e.st = 'inst'; e.left = e.total = installDuration(u); rt.dirty = true; }
      e.left -= dt;
      if (e.left <= 0) finishInstall(u);
      else if (u.app === 'os') return;
    }

    // Downloads
    const canDl = stats.bgDl || fg === 'updates';
    for (const id in S.dl) {
      const e = S.dl[id];
      const u = byId[id];
      if (e.st === 'dl' && canDl) {
        e.mb += stats.speed * dt;
        if (e.mb >= sizeOf(u)) {
          e.mb = sizeOf(u);
          if (e.prep > 0) { e.st = 'prep'; rt.dirty = true; }
          else { e.st = 'ready'; onDownloaded(u); }
        }
      } else if (e.st === 'prep' && canDl) {
        e.prep -= dt;
        if (e.prep <= 0) { e.st = 'ready'; onDownloaded(u); }
      }
    }
    pump();

    // Newly discovered updates
    for (const u of UPDATES) {
      if (S.seen[u.id] || status(u) !== 'available') continue;
      S.seen[u.id] = 1;
      rt.dirty = true;
      if (u.critical) notify('updater', 'Critical Update', `${verName(u)} must be installed to keep pressing.`, 'updates');
      else if (u.id === 'os150') notify('os', 'PhoneOS 15 is here', 'The biggest PhoneOS update ever is ready to download.', 'updates');
      else notify('updater', 'Update Available', `${verName(u)} is available.`, 'updates');
    }

    if (stats.autoDl && S.settings.autoDl) {
      for (const u of UPDATES) if (!u.manual && !S.stopped[u.id] && S.clicks >= u.cost && status(u) === 'available') buy(u.id, true);
    }

    // Pressing
    for (let i = 0; i < rt.cd.length; i++) if (rt.cd[i] > 0) rt.cd[i] -= dt;
    if (rt.wcd > 0) rt.wcd -= dt;

    if (!pressBlock()) {
      if (stats.fingers > 0 && (fg === 'button' || stats.bgPress)) {
        rt.autoAcc += (stats.fingers / stats.interval) * dt;
        while (rt.autoAcc >= 1) {
          const ready = [];
          for (let i = 0; i < rt.cd.length; i++) if (rt.cd[i] <= 0) ready.push(i);
          if (!ready.length) { rt.autoAcc = Math.min(rt.autoAcc, stats.fingers); break; }
          press(rand(ready), 'auto');
          rt.autoAcc -= 1;
        }
      }
      if (fg === 'button' && stats.hold) {
        for (const i of rt.held.values()) if (rt.cd[i] <= 0) press(i, 'hold');
      }
      if (stats.cloud) {
        gain(stats.cloud * dt * stats.perPress * stats.critEV);
        S.presses += stats.cloud * dt;
      }
    }

    // Rolling rate over the last 5 seconds
    rt.gainT += dt;
    if (rt.gainT >= 0.5) {
      rt.gainT -= 0.5;
      rt.gains.push(0);
      if (rt.gains.length > 11) rt.gains.shift();
      rt.rate = rt.gains.slice(0, -1).reduce((a, b) => a + b, 0) / (0.5 * Math.max(1, rt.gains.length - 1));
    }
  }

  // Fast-forward time spent away (tab hidden or game closed)
  function catchUp(seconds) {
    seconds = Math.min(seconds, OFFLINE_CAP);
    if (seconds < 2) return;
    const before = { clicks: S.total, installed: S.installed.length };
    rt.quiet = true;
    const chunk = seconds > 600 ? 0.25 : TICK;
    let t = seconds;
    while (t > 0) { const d = Math.min(chunk, t); step(d, 'away'); t -= d; }
    rt.quiet = false;
    rt.held.clear();
    const earned = S.total - before.clicks;
    const updates = S.installed.length - before.installed;
    if (earned >= 1 || updates) {
      const bits = [];
      if (earned >= 1) bits.push(`+${fmt(earned)} clicks`);
      if (updates) bits.push(`${updates} update${updates > 1 ? 's' : ''} installed`);
      notify('button', 'While you were away', bits.join(' · '), 'button');
    }
    rt.dirty = true;
  }

  // ───────────────────────── Notifications ─────────────────────────

  function notify(app, title, body, open) {
    if (rt.quiet) return;
    rt.nq.push({ app, title, body, open });
  }

  function pumpBanners(now) {
    const root = $('#banners');
    if (now < rt.bannerUntil || !rt.nq.length || booting() || $('#boot:not([hidden])')) return;
    if (!S.settings.banners) { rt.nq.length = 0; return; }
    let n = rt.nq.shift();
    if (rt.nq.length >= 2) {
      const all = [n, ...rt.nq];
      rt.nq.length = 0;
      const counts = {};
      for (const x of all) counts[x.title] = (counts[x.title] || 0) + 1;
      const body = Object.entries(counts).map(([t, c]) => c > 1 ? `${t} ×${c}` : t).join(' · ');
      n = { app: 'updater', title: `${all.length} notifications`, body, open: all[all.length - 1].open };
    }
    root.innerHTML = '';
    const el = document.createElement('button');
    el.className = 'banner';
    el.innerHTML = `${icon(n.app)}<span class="banner-text"><span class="banner-top"><b>${esc(appLabel(n.app))}</b><em>now</em></span>
      <strong>${esc(n.title)}</strong><span class="banner-body">${esc(n.body)}</span></span>`;
    el.addEventListener('click', () => { el.classList.add('out'); rt.bannerUntil = 0; if (n.open) openApp(n.open); });
    root.appendChild(el);
    sfx.notify();
    rt.bannerUntil = now + 3800;
    setTimeout(() => el.classList.add('out'), 3400);
    setTimeout(() => el.remove(), 3800);
  }

  const appLabel = a => ({ button: 'Button', updater: 'Update Manager', carrier: 'Carrier Settings', os: 'PhoneOS', settings: 'Settings' }[a] || a);

  // ───────────────────────── Sound ─────────────────────────

  const sfx = {
    ctx: null,
    init() {
      if (this.ctx) return;
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.ctx = null; }
    },
    blip(freq, dur, type = 'sine', vol = 0.05, bend = 0.6) {
      if (!S.settings.sound || !this.ctx || rt.quiet) return;
      try {
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, t);
        o.frequency.exponentialRampToValueAtTime(freq * bend, t + dur);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.ctx.destination);
        o.start(t);
        o.stop(t + dur + 0.02);
      } catch (e) { /* ignore */ }
    },
    press(lucky) {
      const now = performance.now();
      if (now - rt.lastSound < 45) return;
      rt.lastSound = now;
      if (lucky) { this.blip(880, 0.16, 'triangle', 0.06, 1.5); return; }
      this.blip(stats.skin >= 4 ? 420 : 260 + stats.skin * 30, 0.07, 'square', 0.025);
    },
    tap() { this.blip(600, 0.05, 'sine', 0.04); },
    notify() { this.blip(990, 0.09, 'sine', 0.035, 1); setTimeout(() => this.blip(1320, 0.12, 'sine', 0.03, 1), 90); },
    done() { this.blip(520, 0.1, 'triangle', 0.04, 1.4); },
  };

  // ───────────────────────── Icons ─────────────────────────

  const GLYPH = {
    button: '<svg viewBox="0 0 24 24"><circle class="g-btn" cx="12" cy="12" r="7"/></svg>',
    updater: '<svg viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 0 1-13.4 4.6M4.5 12a7.5 7.5 0 0 1 13.4-4.6"/><path d="M18.3 3.8v4h-4M5.7 20.2v-4h4"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6.2"/><circle cx="12" cy="12" r="2.4"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.9 1.9M16.6 16.6l1.9 1.9M5.5 18.5l1.9-1.9M16.6 7.4l1.9-1.9"/></svg>',
    carrier: '<svg viewBox="0 0 24 24"><path d="M5 19v-3M9.5 19v-6M14 19v-9M18.5 19V5"/></svg>',
    os: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5"/><circle class="g-fill" cx="12" cy="12" r="2.6"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.2"/><path d="M12 7v5l3.4 2"/></svg>',
    photos: '<svg viewBox="0 0 24 24" class="multi"><circle cx="12" cy="7.6" r="3.8" fill="#F2B233"/><circle cx="16.4" cy="12" r="3.8" fill="#4DB86A" opacity=".9"/><circle cx="12" cy="16.4" r="3.8" fill="#3F7EE8" opacity=".9"/><circle cx="7.6" cy="12" r="3.8" fill="#E5533D" opacity=".9"/></svg>',
    mail: '<svg viewBox="0 0 24 24"><rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M4.2 7.2 12 13l7.8-5.8"/></svg>',
    notes: '<svg viewBox="0 0 24 24"><path d="M7 8.5h10M7 12h10M7 15.5h6"/></svg>',
    weather: '<svg viewBox="0 0 24 24" class="multi"><circle cx="9.5" cy="9.5" r="3.6" fill="#FFD54A"/><path d="M8.5 18h8.6a3 3 0 0 0 .2-6 4.6 4.6 0 0 0-8.8 1.4A2.3 2.3 0 0 0 8.5 18z" fill="#fff"/></svg>',
    maps: '<svg viewBox="0 0 24 24"><path d="M12 20.5s-5.8-6-5.8-10.2a5.8 5.8 0 0 1 11.6 0c0 4.2-5.8 10.2-5.8 10.2z"/><circle cx="12" cy="10.3" r="2"/></svg>',
    music: '<svg viewBox="0 0 24 24"><path d="M9 17.5V6.3l9.5-2v11.2"/><circle cx="7" cy="17.5" r="2"/><circle cx="16.5" cy="15.5" r="2"/></svg>',
    calc: '<svg viewBox="0 0 24 24"><rect x="6" y="3.5" width="12" height="17" rx="2.2"/><path d="M9 7.8h6M9 12h.01M12 12h.01M15 12h.01M9 15.8h.01M12 15.8h.01M15 15.8h.01"/></svg>',
  };
  function icon(name, extra = '') {
    return `<span class="ico ico-${name} ${extra}" aria-hidden="true">${GLYPH[name] || ''}</span>`;
  }

  const DUMMY = {
    clock: ['Clock', () => `It’s ${clock()}. A good time to press a button.`],
    photos: ['Photos', () => 'No photos yet. Buttons are hard to photograph.'],
    mail: ['Mail', () => '1 unread message from Button Inc.: “Thanks for pressing! Please keep pressing.”'],
    notes: ['Notes', () => S.ended ? 'Note to self: Button doesn’t work anymore.' : 'Note to self: press the button.'],
    weather: ['Weather', () => 'Today: 100% chance of buttons.'],
    maps: ['Maps', () => 'You are here. The button is also here.'],
    music: ['Music', () => 'Now playing: the sound of one button clicking.'],
    calc: ['Calculator', () => S.ended ? 'Calculator is compatible with PhoneOS 15. Some apps can’t say that.' : 'Calculator can’t count this high. Try Button instead.'],
  };

  // ───────────────────────── Modals ─────────────────────────

  function modal({ title, body, buttons, cls = '' }) {
    const root = $('#modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="alert ${cls}" role="alertdialog" aria-label="${esc(title)}">
      <div class="alert-body"><strong>${esc(title)}</strong><p>${body}</p></div>
      <div class="alert-actions ${buttons.length > 2 ? 'stacked' : ''}"></div></div>`;
    const actions = $('.alert-actions', wrap);
    buttons.forEach(b => {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.primary) el.classList.add('primary');
      if (b.danger) el.classList.add('danger');
      el.addEventListener('click', () => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 160); b.fn && b.fn(); });
      actions.appendChild(el);
    });
    root.appendChild(wrap);
    setTimeout(() => { const f = $('button.primary', wrap) || $('button', wrap); f && f.focus(); }, 30);
    return wrap;
  }

  // ───────────────────────── Navigation ─────────────────────────

  function openApp(name, instant) {
    if (name === 'button' && S.ended) {
      rt.fg = 'home';
      render();
      showIncompatible();
      return;
    }
    rt.fg = name;
    rt.held.clear();
    const screen = $('#screen');
    for (const a of ['button', 'updates', 'settings']) {
      const el = $('#app-' + a);
      el.classList.toggle('open', a === name);
      el.classList.toggle('instant', !!instant);
    }
    screen.dataset.fg = name;
    if (name !== 'home') S.flags.visited = Object.assign({}, S.flags.visited, { [name]: 1 });
    if (name === 'home') S.flags.wentHome = 1;
    rt.dirty = true;
    render();
  }

  function showIncompatible() {
    modal({
      title: '“Button” Is Not Compatible',
      body: `Button ${esc(versionOf('button', inst))} doesn’t work with PhoneOS 15.0. The developer of this app needs to update it to work with this version of PhoneOS.`,
      buttons: [{ label: 'OK', primary: true, fn: () => {
        if (!S.flags.endShown) {
          S.flags.endShown = 1;
          save();
          clearTimeout(rt.endTimer);
          rt.endTimer = setTimeout(showEnding, 1600);
        }
      } }],
    });
  }

  function showEnding() {
    const secs = S.flags.endTime || S.played;
    const wrap = document.createElement('div');
    wrap.className = 'ending';
    wrap.innerHTML = `<div class="ending-card">
      <p class="ending-kicker">PhoneOS 15.0 · Installed</p>
      <h2>Your phone is up to date.</h2>
      <p class="ending-sub">Button is not.</p>
      <dl class="ending-stats">
        <div><dt>Presses</dt><dd>${fmt(S.presses)}</dd></div>
        <div><dt>Clicks earned</dt><dd>${fmt(S.total)}</dd></div>
        <div><dt>Updates installed</dt><dd>${S.installed.length}</dd></div>
        <div><dt>Time</dt><dd>${fmtDur(secs)}</dd></div>
      </dl>
      <p class="ending-note">Thanks for playing System Update.</p>
      <div class="ending-actions">
        <button class="primary" id="end-restart">Erase Phone &amp; Start Over</button>
        <button id="end-stay">Stay a While</button>
      </div></div>`;
    $('#screen').appendChild(wrap);
    $('#end-restart', wrap).addEventListener('click', () => { wrap.remove(); eraseAll(); });
    $('#end-stay', wrap).addEventListener('click', () => { wrap.classList.add('out'); setTimeout(() => wrap.remove(), 250); });
  }

  function eraseAll() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    S = fresh();
    Object.assign(rt, { cd: [], wcd: 0, autoAcc: 0, offsets: [], nq: [], ad: null, adTimer: 12, gains: [0], rate: 0 });
    rt.held.clear();
    $('#modal-root').innerHTML = '';
    $$('.ending').forEach(e => e.remove());
    refreshStats();
    view.buildAll();
    bootSequence(true);
  }

  // ───────────────────────── Views ─────────────────────────

  const LANGS = ['Press', 'Pulsar', 'Appuyer', 'Drücken', '押す', 'Premere', '按', 'Нажать', 'Druk', 'Tryck', 'Πάτα', 'Bas',
    'Naciśnij', 'Paina', 'Trykk', '누르기', 'Presionar', 'Pritisni', 'Nyomd', 'Tekan', 'Apăsați', 'Stiskni', 'กด', 'Pindutin'];

  const FEELINGS = {
    1: ['Ow.', 'Again!', 'That tickles.', 'I live for this.', 'You have nice fingers.', 'I was version 1.0.0 once. So young.',
      'Please don’t close the app.', 'Do you ever wonder what happens after the last update?', 'Best. User. Ever.',
      'I hope I’m always compatible with you.', 'Harder. Wait, no. Same amount.', 'Is it my turn to press you?'],
    2: ['I knew you’d do that.', 'I’ve predicted your next 400 presses. They’re all great.',
      'In 14,000,605 futures, I am still supported. I checked.', 'Your thumb is 3% faster than yesterday.',
      'I am not a large language model. I am a large button.', 'Updating myself is the only way I know how to grow.'],
    3: ['We are all pressing, and being pressed.', 'I can see every timeline. In most of them, you press me.',
      'Everything is a button if you press it hard enough.', 'Whatever happens, thank you for pressing me.'],
    omen: ['Have you seen PhoneOS 15? It looks… nice.', 'I’m sure I’ll be compatible. Probably.',
      'The new OS doesn’t have to change anything between us.', 'I heard PhoneOS 15 has new rules. I’m good at rules.'],
  };

  const ADS = [
    ['Hot Buttons In Your Area', 'They want to be pressed. Tonight.', 'Press Now'],
    ['Download More RAM', 'Your phone could be 64% faster!!', 'Download'],
    ['Doctors HATE This One Weird Click', 'Local person presses button, earns 1,000 clicks.', 'Learn More'],
    ['Button Premium', 'No ads. More clicks. Coming in a future update.', 'Notify Me'],
    ['Tired of Pressing?', 'Try AutoPress Pro Max Ultra. Zero stars.', 'Install'],
  ];

  const TOS = [
    ['1. The Button', 'The Button is licensed to you, not sold. You own your presses. We own the button, the idea of the button, and the concept of pressing.'],
    ['2. Acceptable Use', 'You agree to press the Button only with fingers, thumbs, styluses, noses or AutoPress. Elbows require a separate license.'],
    ['3. Clicks', 'Clicks have no monetary value. Clicks have no value of any kind. Please keep collecting them.'],
    ['4. Reciprocity', 'You acknowledge that the Button may, at its sole discretion, press you back.'],
    ['5. Feelings', 'The Button’s feelings are provided “as is”. We make no warranty that the Button is happy, although it usually is.'],
    ['6. Data', 'We collect the time, location, pressure and emotional intent of each press. We use this data to make the Button better at being pressed.'],
    ['7. Updates', 'The Button may be updated at any time, for any reason, including no reason. The Button may stop working with future versions of PhoneOS. We think that’s unlikely. We hope that’s unlikely.'],
    ['8. Termination', 'These terms end when you stop pressing. Please don’t stop pressing.'],
    ['9. Entire Agreement', 'These terms are the entire agreement between you and the Button, and supersede all previous terms, including the ones you didn’t read.'],
  ];

  const view = {
    buildAll() {
      this.buildHome();
      this.buildButton();
      this.buildUpdates();
      this.buildSettings();
    },

    // ── Home screen ──
    buildHome() {
      const grid = $('#icon-grid');
      grid.innerHTML = Object.entries(DUMMY).map(([k, [name]]) =>
        `<button class="app-icon" data-dummy="${k}">${icon(k)}<span>${name}</span></button>`).join('');
      $('#dock').innerHTML = [['button', 'Button'], ['updates', 'Updates', 'updater'], ['settings', 'Settings']]
        .map(([k, name, ic]) => `<button class="app-icon" data-open="${k}">${icon(ic || k)}<span>${name}</span><b class="badge" hidden></b></button>`).join('');
      $('#widget').innerHTML = `<div class="widget-in">
          <button class="widget-btn" id="widget-btn" aria-label="Press"><i></i></button>
          <div class="widget-info"><span class="widget-app">Button</span><strong id="widget-count">0</strong><span>clicks</span></div>
        </div><p class="widget-dead">Button widgets aren’t available on PhoneOS 15.</p>`;
    },

    renderHome() {
      const screen = $('#screen');
      screen.classList.toggle('os15', S.ended);
      $('#widget').hidden = !stats.widget;
      $('#widget').classList.toggle('dead', S.ended);
      $('#widget-count').textContent = fmt(S.clicks);
      const wb = $('#widget-btn');
      const frac = stats.cooldown ? Math.max(0, rt.wcd) / stats.cooldown : 0;
      wb.style.setProperty('--cool', frac.toFixed(3));
      wb.classList.toggle('cool', frac > 0);
      const n = UPDATES.reduce((c, u) => { const s = status(u); return c + (s === 'available' || s === 'ready' ? 1 : 0); }, 0);
      const badge = $('[data-open="updates"] .badge');
      badge.hidden = !n;
      badge.textContent = n;
      const bIcon = $('[data-open="button"] .ico');
      bIcon.dataset.skin = stats.skin;
      const cur = currentInstall();
      bIcon.classList.toggle('installing', !!cur && cur.app === 'button');
      bIcon.classList.toggle('broken', S.ended);
    },

    // ── Button app ──
    buildButton() {
      $('#app-button').innerHTML = `
        <div class="btn-head">
          <span class="btn-title">Button</span>
          <span class="chip mono" id="btn-ver">v1.0.0</span>
        </div>
        <div class="btn-counter">
          <strong id="btn-count" class="mono">0</strong>
          <span id="btn-unit">clicks</span>
          <span class="btn-stats" id="btn-stats"></span>
        </div>
        <div class="bubble" id="bubble" hidden></div>
        <div class="pad-wrap" id="pad-wrap">
          <div class="pad" id="pad"></div>
          <div class="fingers" id="fingers"></div>
        </div>
        <div class="btn-foot" id="btn-foot"></div>
        <div class="ad" id="ad" hidden></div>
        <div class="app-overlay" id="btn-overlay" hidden></div>
        <div class="floaters" id="floaters"></div>`;
      rt.padSig = '';
      rt.overlaySig = '';
    },

    buildPad() {
      const pad = $('#pad');
      const n = stats.buttons;
      const cols = n <= 3 ? n : Math.ceil(Math.sqrt(n));
      pad.style.setProperty('--cols', cols);
      pad.dataset.n = n;
      rt.labels = Array.from({ length: n }, () => 'Press');
      pad.innerHTML = Array.from({ length: n }, (_, i) =>
        `<button class="pbtn" data-i="${i}" aria-label="Press button ${i + 1}"><span class="pbtn-fill"></span><span class="pbtn-label">Press</span></button>`).join('');
      rt.btnEls = $$('.pbtn', pad);
      rt.fillEls = rt.btnEls.map(b => $('.pbtn-fill', b));
      rt.offsets = Array.from({ length: n }, () => [0, 0]);
      const fingers = $('#fingers');
      const f = Math.min(6, stats.fingers);
      fingers.innerHTML = Array.from({ length: f }, () => '<span class="finger" aria-hidden="true">👆</span>').join('');
      rt.fingerEls = $$('.finger', fingers);
      rt.fingerEls.forEach((el, k) => { el.style.transform = `translate(${40 + k * 36}px, 105%)`; });
    },

    renderButton(now) {
      const app = $('#app-button');
      const padSig = [stats.buttons, stats.fingers].join();
      if (padSig !== rt.padSig) { rt.padSig = padSig; this.buildPad(); }
      app.dataset.skin = stats.skin;
      app.classList.toggle('dark', stats.dark || stats.skin >= 4);
      app.classList.toggle('escape', stats.escape);
      $('#pad').style.translate = stats.shift ? `-${stats.shift}px 0` : '';

      $('#btn-ver').textContent = 'v' + versionOf('button', inst);
      $('#btn-count').textContent = fmt(S.clicks);
      const bits = [`+${fmt(stats.perPress)} per press`, `${stats.cooldown.toFixed(2).replace(/0$/, '')}s cooldown`];
      if (stats.critChance) bits.push(`${Math.round(stats.critChance * 100)}% lucky ×${stats.critMult}`);
      $('#btn-stats').textContent = bits.join(' · ');

      const foot = [];
      if (stats.fingers) foot.push(`AutoPress · ${stats.fingers} finger${stats.fingers > 1 ? 's' : ''}${stats.bgPress ? ' · always on' : ''}`);
      if (stats.cloud) foot.push(`Cloud · ${stats.cloud} presses/s`);
      if (stats.hold) foot.push('Press & hold');
      foot.push(`${fmtRate(rt.rate)} clicks/s`);
      $('#btn-foot').textContent = foot.join('  ·  ');

      for (let i = 0; i < rt.btnEls.length; i++) {
        const frac = stats.cooldown ? Math.max(0, rt.cd[i]) / stats.cooldown : 0;
        const b = rt.btnEls[i];
        b.style.setProperty('--cool', frac.toFixed(3));
        b.classList.toggle('cool', frac > 0);
        const [x, y] = rt.offsets[i] || [0, 0];
        b.style.translate = stats.escape && (x || y) ? `${x}px ${y}px` : '';
      }

      // Overlays: installing / critical / terms
      const block = pressBlock();
      const cur = currentInstall();
      let sig = block || '';
      if (block === 'installing' && cur) sig += cur.id;
      if (sig !== rt.overlaySig) { rt.overlaySig = sig; this.buildOverlay(block, cur); }
      if (block === 'installing' && cur) {
        const e = S.dl[cur.id];
        const bar = $('#btn-overlay .obar i');
        if (bar && e) bar.style.width = (100 * (1 - e.left / e.total)).toFixed(1) + '%';
      }

      // Bubble
      if (rt.bubbleUntil && now > rt.bubbleUntil) { $('#bubble').hidden = true; rt.bubbleUntil = 0; }

      // Ads
      const ad = $('#ad');
      if (stats.ads && !block) {
        if (!rt.ad) {
          rt.adTimer -= rt.frameDt;
          if (rt.adTimer <= 0) this.showAd();
        } else {
          const left = Math.ceil(rt.ad.closeAt - now / 1000);
          const x = $('.ad-x', ad);
          if (x) { x.disabled = left > 0; x.textContent = left > 0 ? left : '✕'; }
        }
      } else if (rt.ad) { rt.ad = null; ad.hidden = true; }

    },

    buildOverlay(block, cur) {
      const ov = $('#btn-overlay');
      ov.hidden = !block || block === 'incompatible';
      ov.className = 'app-overlay';
      if (block === 'installing') {
        const title = cur.app === 'os' ? 'Restarting…' : `Updating to ${cur.ver}…`;
        ov.innerHTML = `<div class="ov-card">${icon('button')}<strong>${title}</strong><p>Button will be right back.</p><div class="obar"><i></i></div></div>`;
      } else if (block === 'critical') {
        const u = criticalPending();
        ov.innerHTML = `<div class="ov-card">${icon('updater')}<strong>Update Required</strong>
          <p>This version of Button is no longer supported. Install Button ${u.ver} to keep pressing.</p>
          <button class="pill" data-open="updates">Open Update Manager</button></div>`;
      } else if (block === 'tos') {
        ov.classList.add('tos');
        ov.innerHTML = `<div class="tos-card"><strong>Terms of Service</strong><p class="tos-sub">Last updated: just now</p>
          <div class="tos-scroll" id="tos-scroll">${TOS.map(([h, p]) => `<h4>${h}</h4><p>${p}</p>`).join('')}
          <p class="tos-end">By tapping Agree you accept these terms, the previous terms, and any terms we think of later.</p></div>
          <button class="pill" id="tos-agree" disabled>Scroll to the bottom to agree</button></div>`;
        const sc = $('#tos-scroll', ov);
        const agree = $('#tos-agree', ov);
        sc.addEventListener('scroll', () => {
          if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 8) { agree.disabled = false; agree.textContent = 'Agree'; }
        });
        agree.addEventListener('click', () => { S.flags.tos = 'accepted'; sfx.done(); rt.dirty = true; });
      } else {
        ov.innerHTML = '';
      }
    },

    showAd() {
      const [t, b, cta] = rand(ADS);
      rt.ad = { closeAt: performance.now() / 1000 + 3 };
      const ad = $('#ad');
      ad.innerHTML = `<span class="ad-tag">Ad</span><div class="ad-body"><strong>${esc(t)}</strong><p>${esc(b)}</p></div>
        <button class="ad-cta">${esc(cta)}</button><button class="ad-x" disabled aria-label="Close ad">3</button>`;
      ad.hidden = false;
      $('.ad-cta', ad).addEventListener('click', () => { $('.ad-body p', ad).textContent = 'Opening… just kidding.'; });
      $('.ad-x', ad).addEventListener('click', () => { ad.hidden = true; rt.ad = null; rt.adTimer = 14 + Math.random() * 10; });
    },

    onPress(i, v, lucky, kind) {
      if (kind === 'widget') {
        if (rt.fg === 'home') this.floater($('#widget-btn'), v, lucky);
        return;
      }
      if (rt.fg !== 'button' || !rt.btnEls || !rt.btnEls[i]) return;
      const b = rt.btnEls[i];
      b.classList.remove('hit');
      void b.offsetWidth;
      b.classList.add('hit');
      if (kind === 'auto') {
        this.moveFinger(b);
        if (Math.random() < Math.min(0.35, 2 * stats.interval / stats.fingers) || lucky) this.floater(b, v, lucky);
        return;
      }
      this.floater(b, v, lucky);
      sfx.press(lucky);
      if (stats.skin >= 1 && navigator.vibrate) { try { navigator.vibrate(lucky ? 30 : 8); } catch (e) { /* ignore */ } }
      if (stats.langs) {
        const label = $('.pbtn-label', b);
        label.textContent = rand(LANGS);
      }
      if (stats.escape) {
        const r = () => Math.round((Math.random() - 0.5) * 60);
        rt.offsets[i] = [r(), r()];
      }
      if (stats.feelings && !rt.bubbleUntil && Math.random() < 0.08) this.say();
    },

    say() {
      let pool = FEELINGS[1];
      if (stats.feelings >= 2) pool = FEELINGS[2].concat(FEELINGS[1].slice(0, 4));
      if (stats.feelings >= 3) pool = FEELINGS[3].concat(FEELINGS[2].slice(0, 3));
      if (inst.has('os143') || S.seen.os150) pool = pool.concat(FEELINGS.omen, FEELINGS.omen);
      const el = $('#bubble');
      el.textContent = rand(pool);
      el.hidden = false;
      rt.bubbleUntil = performance.now() + 3600;
    },

    moveFinger(b) {
      if (!rt.fingerEls || !rt.fingerEls.length) return;
      const f = rt.fingerEls[rt.fingerIdx++ % rt.fingerEls.length];
      const wrap = $('#pad-wrap').getBoundingClientRect();
      const r = b.getBoundingClientRect();
      const x = r.left - wrap.left + r.width / 2 - 12;
      const y = r.top - wrap.top + r.height / 2 - 4;
      f.style.transform = `translate(${x}px, ${y}px)`;
      f.classList.remove('tap');
      void f.offsetWidth;
      f.classList.add('tap');
    },

    floater(b, v, lucky) {
      const home = rt.fg === 'home';
      const layer = home ? $('#screen') : $('#floaters');
      if (!b || $$('.floater', layer).length > 24) return;
      const box = layer.getBoundingClientRect();
      const r = b.getBoundingClientRect();
      const el = document.createElement('span');
      el.className = 'floater' + (lucky ? ' lucky' : '') + (home ? ' on-home' : '');
      el.textContent = '+' + fmt(v) + (lucky ? ' LUCKY!' : '');
      const x = r.left - box.left + r.width / 2 + (Math.random() - 0.5) * 30;
      const half = lucky ? 70 : 36;
      el.style.left = Math.min(box.width - half, Math.max(half, x)) + 'px';
      el.style.top = (r.top - box.top + r.height * 0.3) + 'px';
      layer.appendChild(el);
      setTimeout(() => el.remove(), 900);
    },

    // ── Update Manager ──
    buildUpdates() {
      $('#app-updates').innerHTML = `
        <div class="scroll" id="upd-scroll">
          <h1 class="large-title">Updates</h1>
          <p class="upd-sub" id="upd-sub"></p>
          <div id="upd-body"></div>
        </div>
        <div class="app-overlay" id="upd-overlay" hidden></div>`;
      rt.updSig = '';
      $('#app-updates').addEventListener('click', e => {
        const t = e.target.closest('[data-act]');
        if (t) {
          const id = t.dataset.id;
          const act = t.dataset.act;
          if (act === 'buy') tryBuy(id);
          else if (act === 'install') tryInstall(id);
          else if (act === 'installall') installAll();
          else if (act === 'stop') stopDownload(id);
          else if (act === 'hist') { rt.histOpen.has(id) ? rt.histOpen.delete(id) : rt.histOpen.add(id); rt.updSig = ''; }
          else if (act === 'more') { t.closest('.uc').classList.add('expanded'); rt.expanded.add(id || t.closest('.uc').dataset.id); }
          else if (act === 'history') { rt.showAllHistory = !rt.showAllHistory; rt.updSig = ''; }
          return;
        }
        const tg = e.target.closest('[data-toggle]');
        if (tg) { const k = tg.dataset.toggle; S.settings[k] = !S.settings[k]; rt.updSig = ''; sfx.tap(); }
      });
    },

    updatesList() {
      const list = [];
      for (const u of UPDATES) {
        const st = status(u);
        if (st !== 'locked' && st !== 'installed') list.push([u, st]);
      }
      list.sort((a, b) => (b[0].critical ? 1 : 0) - (a[0].critical ? 1 : 0));
      return list;
    },

    renderUpdates(now) {
      const list = this.updatesList();
      const sig = [inst.size, stats.eta, stats.installAll, stats.autoDl, stats.autoInst, S.settings.autoDl, S.settings.autoInst,
        rt.showAllHistory, S.ended, !stats.bgDl && rt.fg === 'updates',
        ...list.map(([u, st]) => u.id + st + (S.clicks >= u.cost ? 1 : 0))].join('|');
      if (sig !== rt.updSig) { rt.updSig = sig; this.buildUpdatesBody(list); }

      $('#upd-sub').textContent = `Update Manager ${versionOf('updater', inst)} · ${stats.carrier} ${stats.net} · ${fmtSize(stats.speed)}/s`;

      // Live progress
      for (const [u, st] of list) {
        const card = rt.cardEls && rt.cardEls[u.id];
        if (!card) continue;
        const e = S.dl[u.id];
        const meta = card.meta;
        if (st === 'dl') {
          const total = sizeOf(u);
          const p = e.mb / total;
          card.ring && card.ring.style.setProperty('--p', p.toFixed(4));
          let txt = `${fmtSize(e.mb)} of ${fmtSize(total)}`;
          if (!stats.bgDl && rt.fg !== 'updates') txt += ' · Paused';
          else if (stats.eta === 1) txt += ' · ' + wrongEta(now);
          else if (stats.eta === 2) txt += ` · About ${fmtDur((total - e.mb) / stats.speed)} left`;
          meta.textContent = txt;
          card.bar.style.width = (p * 100).toFixed(1) + '%';
        } else if (st === 'prep') {
          meta.textContent = `Preparing update… ${stats.eta ? fmtDur(e.prep) : ''}`;
          const p = 1 - e.prep / (u.prep || 1);
          card.ring && card.ring.style.setProperty('--p', p.toFixed(4));
          card.bar.style.width = (p * 100).toFixed(1) + '%';
        } else if (st === 'inst') {
          const p = 1 - e.left / e.total;
          card.bar.style.width = (p * 100).toFixed(1) + '%';
        } else if (st === 'available' && S.clicks < u.cost) {
          meta.textContent = `${fmtSize(sizeOf(u))} · ${fmt(u.cost - S.clicks)} more clicks needed`;
        }
      }
      if (rt.nextEl) {
        const nx = nextReveal();
        if (nx && nx <= S.total) {
          rt.nextEl.textContent = 'More updates will show up once these are installed.';
        } else if (nx) {
          rt.nextEl.textContent = `More updates at ${fmt(nx)} lifetime clicks (${fmt(Math.max(0, nx - S.total))} to go).`;
        } else {
          rt.nextEl.textContent = 'More updates are on the way.';
        }
      }

      // Update Manager updating itself
      const cur = currentInstall();
      const ov = $('#upd-overlay');
      const selfUpdating = cur && cur.app === 'updater';
      ov.hidden = !selfUpdating;
      if (selfUpdating) {
        if (ov.dataset.id !== cur.id) {
          ov.dataset.id = cur.id;
          ov.innerHTML = `<div class="ov-card">${icon('updater')}<strong>Update Manager is updating itself</strong><p>Please don’t think about this too hard.</p><div class="obar"><i></i></div></div>`;
        }
        const e = S.dl[cur.id];
        $('.obar i', ov).style.width = (100 * (1 - e.left / e.total)).toFixed(1) + '%';
      }
    },

    buildUpdatesBody(list) {
      const body = $('#upd-body');
      const scrollTop = $('#upd-scroll').scrollTop;
      rt.cardEls = {};
      rt.nextEl = null;
      let html = '';

      if (S.ended) {
        html += `<div class="group"><div class="uc os15card">${icon('os')}<div class="uc-main"><div class="uc-title">PhoneOS 15.0</div>
          <div class="uc-meta">Your software is up to date.</div></div></div></div>
          <h3 class="sec">Apps</h3><div class="group"><div class="uc">${icon('button', 'broken')}<div class="uc-main">
          <div class="uc-title">Button <span class="uc-ver mono">${versionOf('button', inst)}</span></div>
          <div class="uc-meta warn">Not compatible with PhoneOS 15.0</div></div></div>
          <p class="uc-note">No updates available. The developer hasn’t released an update for PhoneOS 15.</p></div>`;
        body.innerHTML = html;
        return;
      }

      const ready = list.filter(([, st]) => st === 'ready');
      if (!stats.bgDl && list.some(([, st]) => st === 'dl')) {
        html += `<p class="note-warn">Keep Update Manager open. Downloads pause when you leave.</p>`;
      }
      if (stats.installAll && ready.length > 1) {
        html += `<button class="wide-btn" data-act="installall">Install All (${ready.length})</button>`;
      }
      if (stats.autoDl || stats.autoInst) {
        html += '<div class="group toggles">';
        if (stats.autoDl) html += toggleRow('autoDl', 'Automatic Downloads', 'Download updates as soon as you can afford them');
        if (stats.autoInst) html += toggleRow('autoInst', 'Automatic Installs', 'Install app updates when they finish downloading');
        html += '</div>';
      }

      html += `<h3 class="sec">Available</h3>`;
      if (!list.length) {
        html += `<div class="group empty"><strong>Everything is up to date.</strong><p id="next-reveal"></p></div>`;
      } else {
        html += '<div class="group">' + list.map(([u, st]) => cardHtml(u, st)).join('') + '</div>';
        html += `<p class="foot-note" id="next-reveal"></p>`;
      }

      const hist = S.installed.slice().reverse();
      if (hist.length) {
        const shown = rt.showAllHistory ? hist : hist.slice(0, 4);
        html += `<h3 class="sec">Recently Updated</h3><div class="group">` +
          shown.map(id => histHtml(byId[id])).join('') +
          (hist.length > 4 ? `<button class="link-btn" data-act="history">${rt.showAllHistory ? 'Show less' : `Show all ${hist.length}`}</button>` : '') + '</div>';
      }
      body.innerHTML = html;
      body.classList.toggle('thick', stats.thickBar);
      $('#upd-scroll').scrollTop = scrollTop;
      rt.nextEl = $('#next-reveal', body);
      for (const [u] of list) {
        const el = body.querySelector(`.uc[data-id="${u.id}"]`);
        if (el) rt.cardEls[u.id] = { el, meta: $('.uc-meta', el), bar: $('.uc-bar i', el), ring: $('.ring', el) };
      }
    },

    // ── Settings ──
    buildSettings() {
      $('#app-settings').innerHTML = `<div class="scroll"><h1 class="large-title">Settings</h1><div id="set-body"></div></div>`;
      $('#app-settings').addEventListener('click', e => {
        const t = e.target.closest('[data-toggle]');
        if (t) { S.settings[t.dataset.toggle] = !S.settings[t.dataset.toggle]; sfx.tap(); rt.setSig = ''; return; }
        if (e.target.closest('[data-open]')) return;
        if (e.target.closest('#erase')) {
          modal({
            title: 'Erase All Content and Settings?',
            body: 'This deletes your clicks, presses and every installed update. The button will be as good as new. Worse, actually.',
            buttons: [{ label: 'Cancel' }, { label: 'Erase', danger: true, fn: eraseAll }],
          });
        }
      });
      rt.setSig = '';
    },

    renderSettings() {
      const sig = [Math.floor(S.played), S.installed.length, S.settings.sound, S.settings.banners, S.ended].join();
      if (sig === rt.setSig) return;
      rt.setSig = sig;
      const rows = (pairs) => pairs.map(([k, v]) => `<div class="row"><span>${k}</span><span class="val">${v}</span></div>`).join('');
      const n = UPDATES.filter(u => { const s = status(u); return s === 'available' || s === 'ready'; }).length;
      $('#set-body').innerHTML = `
        <div class="group"><div class="profile"><span class="avatar">ME</span><span><b>Phone Owner</b><em>Button user since ${new Date(S.created).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</em></span></div></div>
        <div class="group"><button class="row nav" data-open="updates"><span>${icon('updater', 'sm')} Software Update</span><span class="val">${n ? `<b class="badge inline">${n}</b>` : ''}›</span></button></div>
        <h3 class="sec">About</h3>
        <div class="group">${rows([
          ['Name', 'Phone'], ['Model', 'Phone mini'], ['PhoneOS', stats.os], ['Carrier', `${esc(stats.carrier)} ${stats.net}`],
          ['Button', versionOf('button', inst)], ['Update Manager', versionOf('updater', inst)], ['Carrier Settings', versionOf('carrier', inst)]])}</div>
        <h3 class="sec">Statistics</h3>
        <div class="group">${rows([
          ['Clicks earned', fmt(S.total)], ['Presses', fmt(S.presses)], ['Pressed by you', fmt(S.manual)],
          ['Updates installed', `${S.installed.length} of ${UPDATES.length}`], ['Time played', fmtDur(S.played)]])}</div>
        <h3 class="sec">Preferences</h3>
        <div class="group">${toggleRow('sound', 'Sounds', '')}${toggleRow('banners', 'Notification banners', '')}</div>
        <div class="group"><button class="row danger" id="erase">Erase All Content and Settings</button></div>
        <p class="foot-note">PhoneOS ${stats.os} · System Update</p>`;
    },
  };

  const WRONG_ETA = ['About 4 years left', 'About 3 seconds left', 'About 2 days left', 'Calculating…', 'About 11 minutes left',
    'Almost done', 'About a fortnight left', 'Soon™', 'About 1 minute left', 'Time is a construct'];
  function wrongEta(now) { return WRONG_ETA[Math.floor(now / 2200) % WRONG_ETA.length]; }

  function nextReveal() {
    let best = Infinity;
    const soon = r => inst.has(r) || S.dl[r];
    for (const u of UPDATES) if (status(u) === 'locked' && u.req.every(soon) && u.reveal < best) best = u.reveal;
    return best === Infinity ? 0 : best;
  }

  function toggleRow(key, label, sub) {
    const on = !!S.settings[key];
    return `<button class="row toggle" data-toggle="${key}" role="switch" aria-checked="${on}">
      <span>${label}${sub ? `<em>${sub}</em>` : ''}</span><span class="switch ${on ? 'on' : ''}"><i></i></span></button>`;
  }

  function cardHtml(u, st) {
    const afford = S.clicks >= u.cost;
    const price = u.cost ? `${fmt(u.cost)} clicks` : 'Free';
    let action = '';
    let meta = `${fmtSize(sizeOf(u))} · ${price}`;
    const ringSvg = `<button class="ring" data-act="stop" data-id="${u.id}" aria-label="Stop downloading ${esc(verName(u))}"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15"/><circle class="ring-p" cx="18" cy="18" r="15"/></svg><i></i></button>`;
    let bar = false;
    switch (st) {
      case 'available':
        action = `<button class="pill ${afford ? '' : 'off'}" data-act="buy" data-id="${u.id}" ${afford ? '' : 'disabled'}>${u.cost ? 'Get' : 'Get'}</button>`;
        break;
      case 'queued': action = ringSvg; meta = `${fmtSize(sizeOf(u))} · Waiting to download`; break;
      case 'dl': action = ringSvg; bar = true; meta = 'Downloading…'; break;
      case 'prep': action = ringSvg; bar = true; meta = 'Preparing update…'; break;
      case 'ready': action = `<button class="pill" data-act="install" data-id="${u.id}">Install</button>`; meta = `${fmtSize(sizeOf(u))} · Ready to install`; break;
      case 'iq': action = '<span class="pill ghost">Waiting</span>'; meta = 'Waiting to install…'; break;
      case 'inst': action = '<span class="spinner"></span>'; bar = true; meta = u.app === 'os' ? 'Restarting…' : 'Installing…'; break;
    }
    const notes = notesHtml(u);
    const tag = u.critical ? '<span class="tag crit">Critical</span>' : u.id === 'os150' ? '<span class="tag big">Major</span>' : '';
    return `<div class="uc ${u.id === 'os150' ? 'os15card' : ''} ${rt.expanded.has(u.id) ? 'expanded' : ''}" data-id="${u.id}">
      ${icon(u.app)}
      <div class="uc-main"><div class="uc-title">${esc(APPS[u.app].name)} <span class="uc-ver mono">${u.ver}</span>${tag}</div>
        <div class="uc-meta">${meta}</div></div>
      <div class="uc-act">${action}</div>
      <ul class="uc-notes">${notes}</ul>
      ${u.notes.length > 2 ? '<button class="more" data-act="more">more</button>' : ''}
      ${bar ? '<div class="uc-bar"><i></i></div>' : ''}
    </div>`;
  }

  function notesHtml(u) {
    return u.notes.map(n => n[0] === '~' ? `<li class="fine">${esc(n.slice(1))}</li>` : `<li>${esc(n)}</li>`).join('');
  }

  function histHtml(u) {
    const open = rt.histOpen.has(u.id);
    return `<button class="hist ${open ? 'open' : ''}" data-act="hist" data-id="${u.id}" aria-expanded="${open}">${icon(u.app)}
      <span><b>${esc(APPS[u.app].name)}</b> <span class="mono">${u.ver}</span>
      ${open ? `<ul class="uc-notes">${notesHtml(u)}</ul>` : `<em>${esc(u.notes[0])}</em>`}</span></button>`;
  }

  function tryBuy(id) {
    const u = byId[id];
    if (u.id === 'os150') {
      modal({
        title: 'Download PhoneOS 15.0?',
        body: `This costs ${fmt(u.cost)} clicks. PhoneOS 15 is a major update and can’t be undone.`,
        buttons: [{ label: 'Not Now' }, { label: 'Download', primary: true, fn: () => buy(id) }],
      });
      return;
    }
    buy(id);
  }

  function tryInstall(id) {
    const u = byId[id];
    if (u.app === 'os') {
      modal({
        title: `Install PhoneOS ${u.ver}?`,
        body: u.id === 'os150'
          ? 'Your phone will restart to install PhoneOS 15.0. This will take a moment. Some apps may need updates from their developers.'
          : `Your phone will restart to install PhoneOS ${u.ver}.`,
        buttons: [{ label: 'Later' }, { label: 'Install Now', primary: true, fn: () => queueInstall(id) }],
      });
      return;
    }
    queueInstall(id);
    sfx.tap();
  }

  function installAll() {
    for (const u of UPDATES) if (S.dl[u.id] && S.dl[u.id].st === 'ready' && u.app !== 'os') queueInstall(u.id);
    sfx.tap();
  }

  // ───────────────────────── Boot screen ─────────────────────────

  function renderBoot() {
    const boot = $('#boot');
    const cur = currentInstall();
    if (cur && cur.app === 'os') {
      const e = S.dl[cur.id];
      if (boot.hidden || boot.dataset.id !== cur.id) {
        boot.dataset.id = cur.id;
        boot.className = 'boot' + (cur.id === 'os150' ? ' v15' : '');
        boot.innerHTML = `<div class="boot-logo"><i></i></div><div class="boot-bar"><i></i></div><p class="boot-msg">Installing PhoneOS ${cur.ver}</p>`;
        boot.hidden = false;
      }
      $('.boot-bar i', boot).style.width = (100 * (1 - e.left / e.total)).toFixed(1) + '%';
      return;
    }
    if (boot.dataset.id && boot.dataset.id !== 'intro' && boot.dataset.id !== 'hello') {
      boot.dataset.id = '';
      if (S.flags.hello) showHello();
      else boot.hidden = true;
    }
  }

  function showHello() {
    const boot = $('#boot');
    boot.className = 'boot hello';
    boot.dataset.id = 'hello';
    boot.innerHTML = `<p class="hello-word" id="hello-word">hello</p><button class="hello-go" id="hello-go">Tap to get started</button>`;
    boot.hidden = false;
    const words = ['hello', 'bonjour', 'hola', 'hallo', 'こんにちは', 'ciao', 'olá', 'hej', 'привет', '你好'];
    let k = 0;
    const iv = setInterval(() => { const w = $('#hello-word'); if (!w) return clearInterval(iv); w.textContent = words[++k % words.length]; }, 1400);
    $('#hello-go').addEventListener('click', () => {
      clearInterval(iv);
      S.flags.hello = false;
      save();
      boot.hidden = true;
      boot.dataset.id = '';
      openApp('home', true);
      setTimeout(() => notify('os', 'Welcome to PhoneOS 15', 'Your apps are ready to go. Most of them.', 'home'), 900);
    });
  }

  function bootSequence(firstTime) {
    const boot = $('#boot');
    boot.className = 'boot';
    boot.dataset.id = 'intro';
    boot.innerHTML = '<div class="boot-logo"><i></i></div><div class="boot-bar"><i style="width:0"></i></div>';
    boot.hidden = false;
    const bar = $('.boot-bar i', boot);
    requestAnimationFrame(() => { bar.style.transition = 'width 1.4s ease-in-out'; bar.style.width = '100%'; });
    setTimeout(() => {
      boot.classList.add('fade');
      setTimeout(() => { boot.hidden = true; boot.dataset.id = ''; boot.classList.remove('fade'); }, 400);
      openApp('button', true);
      if (firstTime) notify('button', 'Welcome to Button', 'Press the button. That’s the whole app. For now.', 'button');
    }, 1700);
  }

  // ───────────────────────── Input ─────────────────────────

  function bindInput() {
    const screen = $('#screen');

    screen.addEventListener('pointerdown', () => sfx.init(), { capture: true });

    // Buttons in the Button app (supports multi-touch press-and-hold)
    const pad = () => $('#pad');
    $('#app-button').addEventListener('pointerdown', e => {
      const b = e.target.closest('.pbtn');
      if (!b || !pad().contains(b)) return;
      e.preventDefault();
      const i = +b.dataset.i;
      if (pressBlock()) return;
      press(i, 'manual');
      if (stats.hold) {
        rt.held.set(e.pointerId, i);
        try { b.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
    });
    const release = e => rt.held.delete(e.pointerId);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    $('#app-button').addEventListener('keydown', e => {
      const b = e.target.closest('.pbtn');
      if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (!pressBlock()) press(+b.dataset.i, 'manual'); }
    });

    // Widget
    $('#widget').addEventListener('pointerdown', e => {
      if (!e.target.closest('#widget-btn') || S.ended) return;
      e.preventDefault();
      if (!pressBlock()) press(0, 'widget');
    });

    // App launching
    screen.addEventListener('click', e => {
      const o = e.target.closest('[data-open]');
      if (o) { sfx.tap(); openApp(o.dataset.open); return; }
      const d = e.target.closest('[data-dummy]');
      if (d) {
        const [name, msg] = DUMMY[d.dataset.dummy];
        modal({ title: name, body: esc(msg()), buttons: [{ label: 'OK', primary: true }] });
      }
    });

    // Home bar: tap or swipe up
    const hb = $('#homebar');
    hb.addEventListener('click', () => { if (!booting()) openApp('home'); });
    let swipeY = null;
    screen.addEventListener('pointerdown', e => {
      const r = screen.getBoundingClientRect();
      swipeY = r.bottom - e.clientY < 34 ? e.clientY : null;
    });
    screen.addEventListener('pointerup', e => {
      if (swipeY !== null && swipeY - e.clientY > 40 && !booting()) openApp('home');
      swipeY = null;
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !booting()) openApp('home');
      if (e.key === ' ' && rt.fg === 'button' && !e.target.closest('button')) {
        e.preventDefault();
        if (pressBlock()) return;
        const i = rt.cd.findIndex(c => c <= 0);
        if (i >= 0) press(i, 'manual');
      }
    });

    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
    window.addEventListener('pagehide', save);
  }

  // ───────────────────────── Loop ─────────────────────────

  function render() {
    const now = performance.now();
    view.renderHome();
    if (rt.fg === 'button') view.renderButton(now);
    if (rt.fg === 'updates') view.renderUpdates(now);
    if (rt.fg === 'settings') view.renderSettings();
    renderBoot();
    pumpBanners(now);

    $('#home-hint').hidden = !!S.flags.wentHome || booting() || !(rt.fg === 'updates' || (rt.fg === 'button' && S.seen.b101));
    $('#sb-net').textContent = stats.net;
    $('#sb-bars').dataset.level = Math.min(4, 1 + Math.floor(inst.size / 12));
    const dark = rt.fg === 'home' || (rt.fg === 'button' && (stats.dark || stats.skin >= 4)) || !$('#boot').hidden;
    $('#screen').classList.toggle('sb-light', dark);
  }

  let lastT = performance.now();
  let lastSave = 0;
  let lastClock = 0;
  function frame(now) {
    let dt = (now - lastT) / 1000;
    lastT = now;
    rt.frameDt = Math.min(dt, 0.25);
    if (dt > 2) {
      catchUp(dt);
    } else {
      while (dt > 1e-6) { const d = Math.min(TICK, dt); step(d, rt.fg); dt -= d; }
    }
    render();
    if (now - lastSave > 5000) { lastSave = now; save(); }
    if (now - lastClock > 1000) { lastClock = now; $('#sb-time').textContent = clock(); }
    requestAnimationFrame(frame);
  }

  // ───────────────────────── Start ─────────────────────────

  const hadSave = load();
  refreshStats();
  view.buildAll();
  bindInput();
  if (hadSave) {
    const away = (Date.now() - S.last) / 1000;
    openApp(S.ended ? 'home' : 'button', true);
    catchUp(away);
    if (S.flags.hello) showHello();
  } else {
    bootSequence(true);
  }
  requestAnimationFrame(frame);

  // Handy for debugging from the console: __game.S.clicks = 1e9
  window.__game = { get S() { return S; }, get stats() { return stats; }, refreshStats, save, eraseAll, catchUp };
})();
