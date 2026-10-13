# NEON DRIFT

A top-down arcade racer set in a synthwave night. Dark asphalt, pink and cyan barriers, a soundtrack that never stops pulsing. You race three AI rivals, and the whole game is built around one thing: drifting. Hold a slide through a corner and your multiplier climbs (x2, x3, x4...), your nitro fills, and the faster you get. Clip a wall too hard and the combo is gone.

Everything you see and hear is generated in code. No image files, no audio files, no libraries.

## Features

**Driving**
- Arcade physics with real weight to it: grip, slip angle, handbrake drifts, counter-steer, power slides
- Drift combo system with a multiplier up to x9, an edge bonus for drifting close to the barriers, and nitro that charges from your drifts
- Boost pads, wall scrapes that cost you speed, car-to-car collisions
- Neon light trails while drifting, tyre marks that stay on the track, sparks, smoke, nitro flames, camera shake and speed zoom
- Smooth camera that turns with the road ahead, never with every twitch of the car, and with a capped rotation speed so it stays comfortable. A tighter chase camera and the classic fixed top-down view are in Settings
- Analog touch steering, vibration feedback on phones and an optional drift assist that counter-steers for you when the car starts to over-rotate

**Game modes**
- **Career**: five cups (Rookie, Pro, Elite, Legend, Cosmic) and 19 races. Finish on the podium to earn stars and unlock the next race, the next cup and new tracks
- **Time Trial**: three laps against the ghost of your best lap, with gold, silver and bronze target times
- **Drift Challenge**: 60 seconds, only drift points count
- **Vs Bots**: offline team races from 1v1 to 5v5 (Race or Drift Battle) with bot teammates and bot opponents, no server needed
- **Endless Road**: a procedurally generated road that never ends. Hit the checkpoints before the clock runs out

**Online team races**
- Race with friends in teams: 1v1, 2v2, 3v3, 4v4 or 5v5. Empty seats are filled with bots (easy, normal or hard)
- No accounts and no email. Each player gets a driver profile created on the device, a short **friend code** to share, and a secret **recovery code** to move the profile to another device
- Friends list with online status, friend requests, in-game invites and shareable invite links (`?join=ROOMCODE`)
- Lobby with team selection, track, laps, weather and bot difficulty, all controlled by the host, plus team shuffle and one-click rematch
- Two online modes: team **Race** and **Drift Battle** (90 seconds, the team with the most drift points wins)
- **Quick play** drops you into an open public room, which starts by itself once two players are in
- Quick messages and a horn in the lobby and during the race
- F1-style team scoring (15, 12, 10, 8, 6...), so every finishing position counts
- Survives dropped connections: players rejoin the same race, and if the host leaves the bots are handed to another player

**Tracks and weather**
Eleven circuits in nine themes: neon city, sunset boulevard, desert, snow and ice (less grip), a dark tunnel where only your headlights and the lamps cut the dark, a cyber grid, a container harbor, a volcano with lava rivers and floating embers, and an orbital space station.
- Buildings, containers and station modules have real height: their walls and roofs lean away from the camera as you drive past
- Rain: wet asphalt with neon reflections, ripples, spray from the tyres, thunder and lightning, and less grip
- **Daily track**: a new procedural circuit every day, the same for everyone, with a daily world ranking

**Progress**
- Three daily challenges with coin rewards, refreshed every day
- 21 achievements, from your first win to finishing the Cosmic Cup
- Replay of every race with play/pause, speed and camera controls, plus a photo mode that saves a clean screenshot

**Skills**
- Eight perks bought and upgraded (3 levels) with coins: Nitro Master, Drift King, Combo Keeper, Armoured, Slipstream, Perfect Launch, Boost Pro and Gold Digger
- Two equip slots, plus a third you can unlock

**Garage**
- Eight cars, each rated on speed, acceleration, grip and drift
- Four upgrade lines (engine, turbo, tyres, drift kit), five levels each
- Ten paint colours and eight neon underglow kits
- Ten body skins (carbon, camo, tiger, circuit, galaxy, lava, ice, holo, gold)
- Trail styles (neon, dashed, fire, lightning, rainbow), decals (stripes, number, checker, flames) and rims (black, chrome, neon, gold)
- Coins come from races, medals and drift points

**Everything else**
- HUD with position, lap, timer, best lap, ghost delta, speedometer, nitro bar, drift combo and a minimap
- Local leaderboards for best laps, drift scores and endless runs
- Synthwave music and sound effects synthesized live with the Web Audio API: an engine note that follows your revs and gears, tyre squeal while sliding, a nitro whoosh. Music and effects can be switched off separately
- Greek and English, switchable at any time
- Keyboard, touch and gamepad controls, plus optional tilt steering on phones
- Fullscreen button, landscape layout and safe-area support for notched phones
- Installable PWA that works offline
- Progress is saved automatically in `localStorage`

## Controls

| Action | Keyboard | Touch |
|---|---|---|
| Steer | ← → or A D | ◀ ▶ pad (or tilt) |
| Throttle | ↑ or W | automatic (can be turned off in Settings) |
| Brake / reverse | ↓ or S | BRAKE |
| Drift (handbrake) | Space | DRIFT |
| Nitro | Shift | NITRO |
| Pause | P or Esc | ❚❚ |

Gamepads work as well: left stick to steer, RT/A for throttle, LT to brake, X/B to drift, RB/Y for nitro.

**Tip:** tap DRIFT as you turn into a corner, keep the throttle on and steer to hold the angle. Chain one corner into the next and the multiplier keeps climbing.

## Tech stack

- One `index.html`: vanilla JavaScript, HTML5 Canvas 2D and CSS
- No frameworks, no build step, no external assets (the only optional network request is Google Fonts, and there are system font fallbacks)
- Procedural graphics: tracks are Catmull-Rom splines sampled into a uniform centreline, rendered into cached 512×512 tiles so the frame cost stays low on phones
- Physics run in fixed sub-steps (around 120 Hz), with the AI driving the same car model as the player
- AI follows a racing line, plans its speed from a curvature profile with braking look-ahead, overtakes, recovers when it gets stuck, and uses nitro on straights
- Web Audio API for everything you hear: oscillators, filtered noise, a small step sequencer with delay for the music
- PWA: `manifest.webmanifest` plus a network-first service worker (`sw.js`)
- Online server: plain Node.js with zero npm dependencies. The WebSocket protocol is implemented by hand on top of `http` and `crypto`
- The server keeps everything in memory (rooms, presence, invites) and stores nothing on disk, so it runs on a free instance with no database. Player identity is derived from the secret code with SHA-256
- Each device simulates its own car and streams its state about 20 times a second. The server relays 20 Hz snapshots, other cars are interpolated with an adaptive delay, and the room host simulates the bots

## Project structure

```
index.html            the whole game
manifest.webmanifest  PWA manifest
sw.js                 service worker (network-first, offline fallback)
icon-180.png          Apple touch icon
icon-192.png          PWA icon
icon-512.png          PWA / maskable icon
package.json          start script for the online server (no dependencies)
server/server.js      online game server (Node.js, zero dependencies)
```

## Running locally

Any static server will do:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080`. Opening `index.html` straight from disk works too, but the service worker only registers over http(s).

## Deploying

The game is a static site. On Render, create a **Static Site** from the repository, leave the build command empty and set the publish directory to the repository root (`.`).

### Online server

The online mode needs the small server in `server/`. It runs on a free Render **Web Service**:

1. New → Web Service → connect the same repository
2. Runtime: Node · Build command: leave empty (or `npm install`) · Start command: `npm start`
3. Instance type: Free · Region: Frankfurt (closest to Greece)

Render gives you an address such as `https://neon-drift-server.onrender.com`. If yours is different, put it in `DEFAULT_SERVER` near the top of the online section in `index.html`, or paste it in Settings → Online server. The Web Service also serves the game itself, so that address works as a complete game link too.

Free instances sleep after 15 minutes without traffic. The server pings its own public URL every 10 minutes to stay awake (set the environment variable `KEEP_AWAKE=0` to turn that off), and the game starts waking it as soon as it loads. A single free service running all month fits inside Render's 750 free hours.

For local testing: `npm start`, then open `http://localhost:8090`. Set `LAG_MS=150` to simulate network latency.

For Android, the folder can be wrapped with Capacitor as it is: point `webDir` at the folder that contains `index.html`.

## Credits

Design and development by **G-navos Developer**
GitHub: [G-Developerr](https://github.com/G-Developerr) · Instagram: [@mhtsos_tzinavos](https://www.instagram.com/mhtsos_tzinavos/)
