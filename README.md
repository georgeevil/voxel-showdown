# Voxel Showdown

An original voxel build-and-battle game for the browser. Harvest a destructible island,
build cover, loot chests and be the last one standing while the storm closes in. One
computer runs the server; everyone on the same Wi-Fi joins from a browser.

## Run it

Needs [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

Open `http://localhost:3000`. The lobby shows the address friends on your network
should open (something like `http://192.168.1.20:3000`). Set `PORT=4000 npm start` to
use another port. If nobody else can connect, allow Node through your firewall.

## Controls

| Key | Action |
|---|---|
| WASD or arrows, Space, Shift | Move, jump, sprint |
| Mouse, or I J K L | Look |
| Left click or F | Swing pickaxe, fire, place a piece |
| Right click (hold) or C (toggle) | Aim / sniper scope |
| 1–4 or scroll | Weapon slot (pickaxe, rifle, shotgun, sniper) |
| Q or B | Build mode (1–4 piece, R rotate, G material) |
| E | Open chest |
| R | Reload |
| Tab | Player list |
| P or F3 | Speed stats (fps, ping) |
| Enter, M, Esc | Chat, mute, menu |

On a tablet or phone the game switches to touch controls on the first touch: left thumb
moves (push far forward to sprint), drag on the right to look, hold FIRE to shoot, tap a
weapon slot to switch, ☰ opens the menu. Touch code lives in `client/touch.js`.

The Esc menu has bot count and skill, island theme, your head, graphics quality, aim
speed and touchpad mode.

## How the code is organised

No build step: plain ES modules, served as they are.

| Path | What is there |
|---|---|
| `shared/constants.js` | Every tunable number: weapons, storm, bot levels, themes, heads |
| `shared/world.js` | Island generation from a seed + theme, voxel raycast, build pieces |
| `shared/physics.js` | Player movement and collision (used by the client and by bots) |
| `server/game.js` | The game server: rules, damage, storm, respawns, WebSocket messages |
| `server/bots.js` | Bot behaviour |
| `server/static.js`, `server/index.js` | Web server and start-up |
| `client/main.js` | Client entry point: message handlers and the frame loop |
| `client/renderer.js`, `mesher.js`, `textures.js`, `theme.js` | Drawing the world |
| `client/hud.js`, `lobby.js`, `minimap.js`, `style.css`, `index.html` | Interface |
| `client/combat.js`, `build.js`, `player.js`, `input.js` | Controls and actions |
| `tests/` | `npm test` — unit and in-process server tests |
| `SPEC.md` | The original design contract (protocol tables, rules). Newer features such as respawns, themes, bot levels and heads were added after it and are described in the code |

The server is authoritative for blocks, damage and match state. Players move on their
own machine and the server sanity-checks positions. Both sides generate the same island
from the seed and theme, so only block changes travel over the network.

## Good first changes

- Tweak numbers in `shared/constants.js` (weapon damage, storm timing, bot levels).
- Add an island theme: copy an entry in `THEMES` and add its id to `THEME_IDS`.
- Add a head style: add a name to `HEADS` and a `case` in `buildHead` in `client/avatars.js`.

Run `npm test` before pushing. Restart the server after changing anything in `server/`
or `shared/`; client-only changes just need a browser refresh.
