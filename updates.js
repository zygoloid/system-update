// Every update in the game, in rough release order.
//
// Fields:
//   id       unique key (also used in saves)
//   app      which app it updates: button | updater | carrier | os
//   ver      the version it installs
//   cost     price in clicks
//   size     download size in MB (before compression upgrades)
//   reveal   lifetime clicks needed before it shows up (default: 60% of cost)
//   req      updates that must be installed first (default: previous update of same app)
//   after    extra prerequisites added to req
//   notes    "What's New" lines; lines starting with "~" are fine print
//   fx       how it changes the stats
//   critical blocks the Button app until installed
//   manual   never auto-downloaded or auto-installed
//   prep     seconds of "Preparing update…" after download (ignores download speed)
//   boot     seconds the phone spends rebooting while installing (OS only)
//   event    something special that happens on install (handled by game.js)
//   typo     { fixedBy, notes }: show these notes instead until update `fixedBy` is installed

(function (root) {
  'use strict';

  const APPS = {
    button: { name: 'Button', base: '1.0.0' },
    updater: { name: 'Update Manager', base: '1.0' },
    carrier: { name: 'Carrier Settings', base: '1.0' },
    os: { name: 'PhoneOS', base: '14.1' },
  };

  function baseStats() {
    return {
      baseCd: 1, cdMult: 1,           // button cooldown (s)
      add: 0, mult: 1,                // per press = (1 + add) * mult
      buttons: 1,
      fingers: 0, baseInterval: 2, intMult: 1, // AutoPress
      bgPress: false,                 // AutoPress works when Button isn't open
      critChance: 0, critMult: 10,
      hold: false,
      cloud: 0,                       // remote presses per second
      speed: 0.25,                    // MB/s
      sizeMult: 1,
      parallel: 1,
      bgDl: false,
      eta: 0,                         // 0 none, 1 wildly wrong, 2 accurate
      installAll: false,
      installTime: 4,
      autoDl: false, autoInst: false,
      skin: 0, dark: false, langs: false, feelings: 0, ads: false, escape: false, shift: 0,
      carrier: 'Carrier', net: 'EDGE',
      widget: false, thickBar: false,
      os: '14.1',
    };
  }

  const U = [
    // ───────────── Early game: just a button ─────────────
    { id: 'b101', app: 'button', ver: '1.0.1', cost: 10, reveal: 10, size: 1.2,
      notes: ['The button now recovers 25% faster.', 'Improved button reliability.'],
      fx: s => { s.baseCd = 0.75; } },

    { id: 'u110', app: 'updater', ver: '1.1', cost: 15, reveal: 12, size: 2.1, after: ['b101'],
      notes: ['Downloads now continue when Update Manager is closed.', 'We know. Revolutionary.'],
      fx: s => { s.bgDl = true; } },

    { id: 'b102', app: 'button', ver: '1.0.2', cost: 25, size: 1.4,
      notes: ['Bug fixes and performance improvements.'],
      fx: s => { s.baseCd = 0.6; } },

    { id: 'b110', app: 'button', ver: '1.1.0', cost: 40, size: 3.2,
      notes: ['Introducing Double Press™: every press now counts twice.'],
      fx: s => { s.add += 1; } },

    { id: 'c20', app: 'carrier', ver: '2.0', cost: 50, size: 0.6, after: ['b110'],
      notes: ['Enables 3G in your area.', 'Your area is this phone.', 'Downloads are 3× faster.'],
      fx: s => { s.speed *= 3; s.net = '3G'; } },

    { id: 'b111', joke: true, app: 'button', ver: '1.1.1', cost: 30, reveal: 60, size: 0.1,
      notes: ['Moved the button 2 pixels to the left.', 'That’s it. That’s the update.'],
      fx: s => { s.shift = 2; } },

    { id: 'b120', app: 'button', ver: '1.2.0', cost: 100, size: 5.5,
      notes: ['A second button!', 'Each button has its own cooldown. Alternate for maximum pressing.'],
      fx: s => { s.buttons = 2; } },

    { id: 'u120', app: 'updater', ver: '1.2', cost: 130, size: 5.4,
      notes: ['Now shows estimated time remaining.', 'Added “Install All”.'],
      fx: s => { s.eta = 1; s.installAll = true; } },

    { id: 'b130', app: 'button', ver: '1.3.0', cost: 190, size: 5.6,
      notes: ['A fresh new look. Rounded corners are back.',
        'Haptic feedback: presses feel 50% more satisfying (+1 per press).'],
      fx: s => { s.add += 1; s.skin = Math.max(s.skin, 1); } },

    { id: 'b131', joke: true, app: 'button', ver: '1.3.1', cost: 72, reveal: 190, size: 1.1,
      notes: ['Dark Mode. For pressing at night.'],
      fx: s => { s.dark = true; } },

    { id: 'os1411', app: 'os', ver: '14.1.1', cost: 210, reveal: 126, size: 9, boot: 5,
      notes: ['This update provides important security fixes and is recommended for all users.',
        'Fixes an issue where the button could be pressed by a sufficiently determined squirrel.'],
      fx: s => { s.os = '14.1.1'; } },

    { id: 'b140', app: 'button', ver: '1.4.0', cost: 310, size: 5.9,
      notes: ['Press & Hold: keep a finger on a button and it presses itself whenever it’s ready.',
        'Works with several fingers, if you have them.'],
      fx: s => { s.hold = true; } },

    { id: 'u130', app: 'updater', ver: '1.3', cost: 220, size: 6.1,
      notes: ['Updates install twice as fast.', 'Time remaining estimates now use maths.'],
      fx: s => { s.installTime = 2; s.eta = 2; } },

    { id: 'c30', app: 'carrier', ver: '3.0', cost: 220, size: 1.5, after: ['b140'],
      notes: ['4G LTE is here.', 'Downloads are 4× faster.'],
      fx: s => { s.speed *= 4; s.net = '4G'; } },

    // ───────────── AutoPress era ─────────────
    { id: 'b200', app: 'button', ver: '2.0.0', cost: 320, size: 25,
      notes: ['Introducing AutoPress: a tiny robot finger that presses buttons for you.',
        'A third button, so it has something to do.', 'All-new design.', '~AutoPress only works while Button is open.'],
      fx: s => { s.fingers = 1; s.baseInterval = 1.5; s.buttons = 3; s.skin = Math.max(s.skin, 2); } },

    { id: 'u140', joke: true, app: 'updater', ver: '1.4', cost: 88, reveal: 320, size: 4.5,
      notes: ['Progress bars are now 30% thicker, so downloads feel faster.'],
      fx: s => { s.thickBar = true; } },

    { id: 'b201', app: 'button', ver: '2.0.1', cost: 410, size: 26,
      notes: ['AutoPress now does warm-up stretches.', 'It presses twice as often.'],
      fx: s => { s.baseInterval = 0.75; } },

    { id: 'b210', app: 'button', ver: '2.1.0', cost: 490, size: 27,
      notes: ['Four buttons in a convenient 2×2 grid.'],
      fx: s => { s.buttons = 4; } },

    { id: 'b211', app: 'button', ver: '2.1.1', cost: 500, size: 27,
      notes: ['Button springs are now 25% springier.'],
      fx: s => { s.baseCd = 0.45; } },

    { id: 'u200', app: 'updater', ver: '2.0', cost: 350, size: 28,
      notes: ['Download two updates at the same time.', 'Downloads you can’t start yet wait in a queue.'],
      fx: s => { s.parallel = 2; } },

    { id: 'b220', app: 'button', ver: '2.2.0', cost: 510, size: 29,
      notes: ['Lucky Presses: each press has a 5% chance to be worth 10×.'],
      typo: { fixedBy: 'b221', notes: ['Lcuky Presses: each press has a 5% chance to be worth 10×.'] },
      fx: s => { s.critChance = 0.05; s.critMult = 10; } },

    { id: 'b221', joke: true, app: 'button', ver: '2.2.1', cost: 150, reveal: 510, size: 4.5,
      notes: ['Fixed a typo in the notes for Button 2.2.0.', 'Fixed a typo in the notes for Button 2.2.1.'],
      typo: { fixedBy: 'b221', notes: ['Fixed a typo in the notes for Button 2.2.0.', 'Fixed a typo in the ntoes for Button 2.2.1.'] },
      fx: () => {} },

    { id: 'c40', app: 'carrier', ver: '4.0', cost: 530, size: 6, after: ['u200'],
      notes: ['5G. The G stands for “Gotta go fast”.', 'Your carrier is now called Carrier+.', 'Downloads are 5× faster.'],
      fx: s => { s.speed *= 5; s.net = '5G'; s.carrier = 'Carrier+'; } },

    { id: 'b230', app: 'button', ver: '2.3.0', cost: 770, size: 150,
      notes: ['Button is now available in 40 languages.', 'Each language adds a little extra press (+2 per press).'],
      fx: s => { s.add += 2; s.langs = true; } },

    { id: 'b240', app: 'button', ver: '2.4.0', cost: 1300, size: 150,
      notes: ['Button now has feelings.', 'Happy buttons press 50% harder.'],
      fx: s => { s.mult *= 1.5; s.feelings = 1; } },

    { id: 'b241', app: 'button', ver: '2.4.1', cost: 2000, size: 160,
      notes: ['AutoPress got lonely, so we gave it a friend. (+1 finger)'],
      fx: s => { s.fingers += 1; } },

    { id: 'b250', app: 'button', ver: '2.5.0', cost: 2600, size: 160,
      notes: ['Presses are now worth 3×.', '~Known issue: buttons may try to escape.'],
      fx: s => { s.mult *= 3; s.escape = true; } },

    { id: 'b251', app: 'button', ver: '2.5.1', cost: 0, reveal: 0, size: 2.5, critical: true, event: 'apology',
      notes: ['Critical update: buttons no longer escape.', 'Please don’t ask where they were going.',
        'As an apology, here are 2,000 clicks.'],
      fx: s => { s.escape = false; } },

    { id: 'u210', app: 'updater', ver: '2.1', cost: 5700, size: 160,
      notes: ['Automatic Downloads: updates you can afford download by themselves.'],
      fx: s => { s.autoDl = true; } },

    { id: 'b260', app: 'button', ver: '2.6.0', cost: 8200, size: 170,
      notes: ['AutoPress fingers are now ambidextrous.', '+1 finger, and every finger presses 50% more often.'],
      fx: s => { s.fingers += 1; s.baseInterval = 0.5; } },

    { id: 'b261', app: 'button', ver: '2.6.1', cost: 0, reveal: 0, size: 0.8, event: 'tos',
      notes: ['We’ve updated our Terms of Service.', 'You’ll need to accept them to keep pressing.'],
      fx: () => {} },

    { id: 'c50', app: 'carrier', ver: '5.0', cost: 9200, size: 30,
      notes: ['5G Ultra Wideband. Even wider.', 'Downloads are 4× faster.'],
      fx: s => { s.speed *= 4; s.net = '5G UW'; } },

    { id: 'u220', app: 'updater', ver: '2.2', cost: 9300, size: 700,
      notes: ['Updates are now compressed, so they’re 30% smaller.',
        'This update updates the updater that updates your updates.'],
      fx: s => { s.sizeMult *= 0.7; } },

    // ───────────── Monetisation era ─────────────
    { id: 'b300', app: 'button', ver: '3.0.0', cost: 13000, size: 1000,
      notes: ['Button is now FREE! (with ads)', 'Ad revenue lets us double the value of every press.',
        'Bold new design.'],
      fx: s => { s.mult *= 2; s.ads = true; s.skin = Math.max(s.skin, 3); } },

    { id: 'u221', joke: true, app: 'updater', ver: '2.2.1', cost: 4600, reveal: 13000, size: 130,
      notes: ['Fixed an issue where Update Manager would try to update itself while updating itself.'],
      fx: () => {} },

    { id: 'b310', app: 'button', ver: '3.1.0', cost: 28000, size: 1000,
      notes: ['Button Premium: ads removed.', 'Premium presses are 50% more premium.'],
      fx: s => { s.ads = false; s.mult *= 1.5; } },

    { id: 'u300', app: 'updater', ver: '3.0', cost: 29000, size: 1100,
      notes: ['Automatic Installs: downloaded updates install themselves.', '~Doesn’t apply to PhoneOS updates.'],
      fx: s => { s.autoInst = true; s.installTime = 1.5; } },

    { id: 'b320', app: 'button', ver: '3.2.0', cost: 42000, size: 1100,
      notes: ['A 3×3 grid. Nine buttons. One dream.', 'Buttons recover a little faster, too.'],
      fx: s => { s.buttons = 9; s.baseCd = 0.4; } },

    { id: 'b330', app: 'button', ver: '3.3.0', cost: 43000, size: 1100,
      notes: ['AutoPress now keeps pressing when you’re not looking.',
        'Including when you close the app. Especially then.', '+1 finger.'],
      fx: s => { s.bgPress = true; s.fingers += 1; s.baseInterval = 0.4; } },

    { id: 'os142', app: 'os', ver: '14.2', cost: 44000, size: 2100, boot: 7, prep: 6, after: ['b330'],
      notes: ['Home Screen widgets. Put a button right on your home screen.',
        'Everything is 15% snappier.', 'Improved battery life when pressing buttons.'],
      fx: s => { s.os = '14.2'; s.widget = true; s.cdMult *= 0.85; s.intMult *= 0.85; } },

    { id: 'c60', app: 'carrier', ver: '6.0', cost: 51000, size: 170,
      notes: ['6G (beta).', 'Downloads are 5× faster.', '~May cause mild time dilation.'],
      fx: s => { s.speed *= 5; s.net = '6G'; } },

    // ───────────── AI era ─────────────
    { id: 'b400', app: 'button', ver: '4.0.0', cost: 74000, size: 5700,
      notes: ['Button AI: predicts your presses before you make them.',
        'Presses are worth 2×.', 'Two extra AI-powered fingers.', 'New look.'],
      fx: s => { s.mult *= 2; s.fingers += 2; s.feelings = 2; s.skin = Math.max(s.skin, 4); } },

    { id: 'b401', joke: true, app: 'button', ver: '4.0.1', cost: 32000, reveal: 74000, size: 640,
      notes: ['Button AI will no longer answer questions about the meaning of life.'],
      fx: () => {} },

    { id: 'b410', app: 'button', ver: '4.1.0', cost: 210000, size: 5800,
      notes: ['Lucky Presses are luckier: 15% chance, worth 25×.'],
      fx: s => { s.critChance = 0.15; s.critMult = 25; } },

    { id: 'u400', app: 'updater', ver: '4.0', cost: 470000, size: 5900,
      notes: ['Delta Updates: only download the bits that changed. Updates are 70% smaller.',
        'Four downloads at once.'],
      fx: s => { s.sizeMult *= 0.3; s.parallel = 4; } },

    { id: 'b420', app: 'button', ver: '4.2.0', cost: 680000, size: 20000,
      notes: ['A 4×4 grid. We had to make the buttons smaller.', 'Buttons recover faster.'],
      fx: s => { s.buttons = 16; s.baseCd = 0.3; } },

    { id: 'b430', app: 'button', ver: '4.3.0', cost: 690000, size: 20000,
      notes: ['Buttons are now made from 100% recycled presses (+10 per press).'],
      fx: s => { s.add += 10; } },

    { id: 'c70', app: 'carrier', ver: '7.0', cost: 1.5e6, size: 2900,
      notes: ['A fiber optic cable now runs directly into your phone.', 'Downloads are 10× faster.',
        'Please don’t trip over it.'],
      fx: s => { s.speed *= 10; s.net = 'FIBER'; s.carrier = 'Carrier+ Pro'; } },

    // ───────────── Late game ─────────────
    { id: 'b500', app: 'button', ver: '5.0.0', cost: 2.1e6, size: 210000,
      notes: ['Button Cloud: 1,000 strangers now press your button remotely (20 presses/s).',
        'We have not asked them why.', 'Glassy new design.'],
      fx: s => { s.cloud = 20; s.skin = Math.max(s.skin, 5); } },

    { id: 'b510', app: 'button', ver: '5.1.0', cost: 4.2e6, size: 210000,
      notes: ['Every press is now recorded forever on the Buttonchain.',
        'Presses are worth 3× because they are now “assets”.'],
      fx: s => { s.mult *= 3; } },

    { id: 'u500', app: 'updater', ver: '5.0', cost: 8.9e6, size: 210000,
      notes: ['Update Manager is now fully autonomous.', 'Eight downloads at once. Installs are nearly instant.',
        'It no longer needs you. It still likes you, though.'],
      fx: s => { s.parallel = 8; s.installTime = 0.4; } },

    { id: 'b600', app: 'button', ver: '6.0.0', cost: 13e6, size: 210000,
      notes: ['A 5×5 grid.', 'Twelve AutoPress fingers. We don’t ask where they came from.'],
      fx: s => { s.buttons = 25; s.baseCd = 0.22; s.fingers = Math.max(s.fingers, 12); } },

    { id: 'os143', app: 'os', ver: '14.3', cost: 13e6, size: 360000, boot: 7, prep: 6, after: ['b600'],
      notes: ['Improved performance for apps that press things (2× press value).',
        'Prepares your phone for PhoneOS 15.'],
      fx: s => { s.os = '14.3'; s.mult *= 2; } },

    { id: 'b700', app: 'button', ver: '7.0.0', cost: 38e6, size: 220000,
      notes: ['Button has achieved enlightenment.', 'Every press now echoes across all timelines (5×).'],
      fx: s => { s.mult *= 5; s.feelings = 3; s.skin = Math.max(s.skin, 6); } },

    { id: 'c80', app: 'carrier', ver: '8.0', cost: 130e6, size: 29000,
      notes: ['Quantum Entanglement Link.', 'Downloads finish before they start.', 'Sometimes before you start them.'],
      fx: s => { s.speed *= 1000; s.net = 'QE'; } },

    { id: 'b710', app: 'button', ver: '7.1.0', cost: 190e6, size: 1200,
      notes: ['Button is ready for anything.', 'Well. Almost anything. (2× press value)'],
      fx: s => { s.mult *= 2; } },

    { id: 'os150', app: 'os', ver: '15.0', cost: 980e6, size: 480000, boot: 10, prep: 20, manual: true,
      after: ['b710', 'c80', 'u500'], event: 'ending',
      notes: ['The biggest PhoneOS update ever.', 'A stunning new design, top to bottom.',
        'Smarter notifications, snappier everything.', 'Hundreds of new features.',
        '~Some older apps may no longer be compatible.'],
      fx: s => { s.os = '15.0'; } },
  ];

  const byId = {};
  const lastOfApp = {};
  for (const u of U) {
    if (byId[u.id]) throw new Error('duplicate update ' + u.id);
    byId[u.id] = u;
    if (!u.req) u.req = lastOfApp[u.app] ? [lastOfApp[u.app]] : [];
    if (u.after) u.req = u.req.concat(u.after);
    if (u.reveal === undefined) u.reveal = Math.round(u.cost * 0.6);
    lastOfApp[u.app] = u.id;
  }
  for (const u of U) for (const r of u.req) if (!byId[r]) throw new Error(u.id + ' requires unknown ' + r);
  for (const u of U) if (u.typo && !byId[u.typo.fixedBy]) throw new Error(u.id + ' typo fixed by unknown ' + u.typo.fixedBy);

  function computeStats(installed) {
    const s = baseStats();
    for (const u of U) if (installed.has(u.id)) u.fx(s);
    s.cooldown = Math.max(0.08, s.baseCd * s.cdMult);
    s.interval = s.baseInterval * s.intMult;
    s.perPress = (1 + s.add) * s.mult;
    s.critEV = 1 + s.critChance * (s.critMult - 1);
    return s;
  }

  function versionOf(app, installed) {
    let v = APPS[app].base;
    for (const u of U) if (u.app === app && installed.has(u.id)) v = u.ver;
    return v;
  }

  root.GameData = { APPS, UPDATES: U, byId, computeStats, versionOf };
})(typeof window !== 'undefined' ? window : globalThis);
