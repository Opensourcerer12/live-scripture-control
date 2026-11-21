# Live Scripture Control

A local web app for the FreeShow PC. It shows the song list, the verses of the current song,
3–5 scripture suggestions, and puts a chosen passage on screen through FreeShow's own API.

- **PC view** — `http://localhost:8099` — songs, verses, suggestions, manual reference, lock, clear.
- **Phone view** — `http://<lan-ip>:8099/phone` — one large live card, big suggestion buttons,
  always-visible CLEAR, plus a song/verse picker. Phones pair with a 4-digit PIN.
- Runs entirely on the church PC. No internet needed during a service.

**Download:** the Windows installer and a portable build are on the
[releases page](https://github.com/Opensourcerer12/live-scripture-control/releases/latest).

## Run it

On Windows, double-click **`Start Live Scripture.cmd`**. It installs the one dependency the first
time, refuses to start a second copy, opens the PC view in your browser, and keeps its log window
visible — leave that window open during the service.

From a terminal:

```bash
npm install
npm start
```

The console prints the PC URL, the phone URL(s) for this network, and the PIN.
FreeShow must be running with **Connections → API** enabled (ports 5505/5506).

Optional: `npm run probe` re-runs the API capability check against FreeShow and prints what
works — see `docs/FREESHOW-API-FINDINGS.md` for what it found on this install.

## Desktop app (installer)

`npm run dist` builds a Windows app with electron-builder into `dist/`:

- **`Live Scripture Control Setup 1.0.0.exe`** — installer (per user, no admin rights; desktop shortcut).
- **`live Scripture Control 1.0.0.exe`** — portable build: no install, run it from anywhere.

The app opens the same PC view in its own window, so the church PC needs **no Node.js install and no
terminal**. The server runs inside the app on the configured port; the phone view still works at
`http://<lan-ip>:8099/phone` and stays paired.

**Where the data lives:** inside the app the writable files move to
`%APPDATA%\live-scripture-control\data` — `config.json`, `session.json`, `verse-bindings.json` and
`suggestions-cache.json` are created there on first run from the bundled Bible and pins. Upgrades
never overwrite them. `File → Check setup` runs the same checks as `npm run doctor`, and
`File → Open log file` shows the app's log.

The terminal/browser workflow (`npm start`) is unchanged and keeps using the project folder — that
is the development path, and it is what `config.json` in this folder is for.

## Moving to the church PC

Nothing here is tied to one machine except `config.json`. With the installer, steps 1–2 and 4 are
skipped: install the app, open it once, then pair phones. Pinned scriptures travel by copying
`data\verse-bindings.json` into `%APPDATA%\live-scripture-control\data`.

**Copy this, not the project folder.** `npm run copy-church` builds `..\Live Scripture Control (church PC)`
from the app source only — no `dist\` build output (about 585 MB of `win-unpacked`, blockmaps and
debug files), no `node_modules`, no this PC's `config.json` or `data\session.json`.
`npm run copy-church -- --with-installer` also drops the two `.exe` installers into `installer\` in
that folder, so one folder carries both ways to run it.

Running from source instead:

1. Install **Node.js LTS** (18 or newer) from nodejs.org.
2. Copy this folder across (leave `node_modules` behind; the launcher reinstalls it).
3. Start FreeShow once on that PC so it creates `Documents\FreeShow\Shows`, enable
   **Connections → API**, and copy the song library over if it is not already there.
4. With the app stopped, run **`node scripts/new-pc.mjs`** in the copied folder. It points
   `showsDir` at this PC's FreeShow library, issues a fresh phone PIN and unpairs the phones
   from the old PC. Pinned scriptures and the suggestion cache are kept.
5. **`Check setup.cmd`** — confirms Node, the song library, the Bible file, FreeShow's API on
   5505/5506, whether the output window is actually visible, and the display arrangement.
6. Set Windows to **Extend** (`Win+P`) and put FreeShow's output window on the projector. In
   Duplicate mode the congregation sees everything on your desktop.
7. Optional: **`Enable autostart.cmd`** starts the app minimised at log-on; `Disable autostart.cmd`
   removes it.

`config.example.json` is a clean, machine-neutral config. `pin` and `tokens` are generated on
first run, so it is safe to start from it. `data/verse-bindings.json` holds your pinned
scriptures keyed by FreeShow show id — it only stays valid if the same song library comes along.

## What it does when you tap a suggestion

1. The verse text is resolved locally from the Bible file.
2. The app writes it into a dedicated FreeShow show named **“Live Scripture”** (`set_plain_text`).
3. That show is started if it is not already live (`start_show`) — if it is already live, the
   text changes with no transition.
4. The app reads FreeShow's own output text back (`get_output_slide_text`) to confirm the verse
   actually reached the screen, and reports failure honestly if it did not.

This is the only live path that survived testing: `index_select_project_item` merely highlights
a row in the project list and never reaches output. Details in
`docs/FREESHOW-API-FINDINGS.md`.

## Settings — `config.json`

Created on first run.

| Key | Meaning |
| --- | --- |
| `appPort` / `appHost` | Web app port (default `8099`) and bind address (`0.0.0.0` = visible on the LAN) |
| `freeshow.host` | FreeShow PC (usually `127.0.0.1`) |
| `freeshow.httpPort` | HTTP action route, default `5505` |
| `freeshow.restPort` | REST POST route, default `5506` |
| `freeshow.showName` | Show used to carry the live verse, default `Live Scripture` |
| `showsDir` | FreeShow song library, default `~/Documents/FreeShow/Shows` |
| `translation` | `KJV` (see licensing below) |
| `pin` | Phone pairing PIN, shown on the PC view |

The PIN and paired phone tokens persist, so phones stay paired across restarts.

## Safeguards

- **Lock phones** (PC) — phones can no longer change what is on screen (`423` from the API, buttons
  disabled). CLEAR still works from both, deliberately: a blank screen is always safe.
- **CLEAR** on both views blanks the output immediately.
- **PIN pairing** — a phone must be paired once; it then keeps a token. Localhost (the PC) never
  needs a token. Unpaired devices get `401`, and unpaired WebSockets are closed.
- The app only **reads** song files. It never edits songs, projects, or templates.

### One manual cleanup after the first run

FreeShow's `create_show` appends the new show to the **currently open project**. So the first time
the app creates “Live Scripture”, one extra row appears in that project. Delete that row in FreeShow
(select it, press Delete) — the app does not need the show to be a project item, and it does not
remove project rows itself (the API's `remove_project_item` splices by internal index and can delete
the wrong song — measured, see the findings doc).

## Songs and verses

Read directly from `Documents/FreeShow/Shows/*.show`. Each file is `[showId, show]`; verses follow
the show's active layout, and the lyric comes from the first text box of each slide. The app reads
the files rather than the API so it works even when FreeShow is closed.

## Suggestions — offline

No internet, no model. A curated theme index (44 themes, ~170 passages: holiness, grace, cross,
shepherd, healing, mission, …) is scored against the lyric word by word, the strongest themes supply
passages round-robin, and the result is cached per translation + lyric in
`data/suggestions-cache.json`. Same input, same suggestions — predictable in a service.

## Translations and licensing

- **KJV** is bundled: `data/kjv.json`, public domain, 31,102 verses.
- **NIV** and **ESV** are **copyrighted and not bundled**. The selector lists them, but they stay
  disabled until you add your own licensed file in the same schema:

  ```json
  [{ "abbrev": "gn", "name": "Genesis", "chapters": [["verse one", "verse two"]] }]
  ```

  Save it as `data/niv.json` or `data/esv.json` and restart. Check your licence before doing this —
  bundling or distributing NIV/ESV text without permission is not allowed.

## Bulk prep (phase two — not built yet)

The suggestion engine needed for bulk prep already exists (`server/suggestions.mjs`, `suggest()`),
so phase two only has to:

1. walk every show in the library and every verse in it,
2. call `suggest()` per verse and cache the result,
3. write the chosen passages into the FreeShow project as new slides, cloning the user's existing
   split-screen slide geometry and the scripture item text, and appending to project items.

It must never rewrite an original song or `templates.json`. Doing this safely needs FreeShow closed
(or a project copy) because FreeShow keeps project state in memory and overwrites files on save.
