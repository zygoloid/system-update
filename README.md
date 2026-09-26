# System Update

An incremental game about a button, played on a pretend phone.

You start with one plain button. Pressing it earns a click, then it goes grey for a second. At 10 clicks,
**Button 1.0.1** becomes available in the Update Manager. From there it's updates all the way down: faster
buttons, more buttons, AutoPress robot fingers, lucky presses, ads, Button Premium, Button AI, the Buttonchain,
carrier upgrades from EDGE to a quantum link, and updates to the Update Manager itself until it installs
everything on its own. The last update is PhoneOS 15.

## Playing

Open `index.html` in a browser. Nothing needs building or installing.

```sh
npx http-server .   # or: python3 -m http.server
```

- Tap **Press** in the Button app to earn clicks.
- Notifications tell you when updates are available. Tap one, or open **Updates** from the Home Screen.
- Tap the bar at the bottom of the screen (or swipe up, or press <kbd>Esc</kbd>) to go Home.
- On a keyboard, <kbd>Space</kbd> presses the next ready button.
- Progress saves in `localStorage`. Settings → *Erase All Content and Settings* starts over.

A full playthrough takes about 40 minutes.

## How it works

| File | What's in it |
| --- | --- |
| `updates.js` | Every update: version, price, download size, changelog and its effect on the game's stats. |
| `game.js` | Game state, the simulation step, saving, offline progress and all the phone UI. |
| `style.css` | The phone, the home screen, the Button app's seven visual styles, Update Manager and Settings. |
| `tools/balance-sim.js` | Plays the game with a simple player model and prints when each update lands. |
| `tools/tune.js` | Suggests prices and sizes so each update takes about the same time to afford and download. |

### Adding an update

Add an entry to the list in `updates.js`:

```js
{ id: 'b212', app: 'button', ver: '2.1.2', cost: 600, size: 4,
  notes: ['Buttons are now 10% more buttony.'],
  fx: s => { s.add += 1; } },
```

By default an update requires the previous update for the same app and appears once lifetime clicks reach
60% of its price. Use `req`, `after` and `reveal` to change that. See the comment at the top of `updates.js`
for the other fields (`critical`, `manual`, `prep`, `boot`, `event`).

Check the pacing after changes:

```sh
node tools/balance-sim.js      # assumes 4 taps per second
node tools/balance-sim.js 2    # a lazier player
```

In the browser console, `__game.S` is the live save data (try `__game.S.clicks = __game.S.total = 1e9`).
