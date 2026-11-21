# FreeShow API findings (measured on this install)

Everything below was tested against the running FreeShow on this PC on 2026-11-17,
using `scripts/probe-freeshow.mjs` plus direct calls. Nothing here is assumed.

## Endpoints

| Transport | Port | Shape | Result |
| --- | --- | --- | --- |
| REST | 5506 | `POST /` body `{"action":"X", ...}` | works, returns JSON for `get_*` actions, `204` otherwise |
| HTTP | 5505 | `GET /?action=X&data={json}` | works (same Express app as REST) |
| WebSocket | 5505 | socket.io, event `data`, JSON **string** `{"action":"X",...}` | connects, actions accepted |
| OSC | 5505 | UDP `/freeshow/*` | enabled by the same listener, not used here |

`GET /` on either port answers `204` for any path — that is not a health signal.

Notes:

- Every `get_*` reply is **wrapped**: `{"action":"get_output","data":{...}}`. Unwrap `data`.
- `get_shows` / `get_projects` return **objects keyed by id**, not arrays.
- The WebSocket listener and the REST listener share one Express app, so the query form also
  works on 5506 and the JSON body form on 5505. Use REST first (fast), query as fallback.
- A password can be set in FreeShow; it is accepted via `Authorization: Bearer`, `?password`,
  or an `auth`/`token` field. Not set on this machine.

## What `index_select_project_item` actually does

`src/frontend/components/actions/api.ts`:

```ts
index_select_project_item: (data: API_index) => selectProjectShow(data.index)
```

`selectProjectShow()` sets `activeShow` — it **highlights the row in the project list only**.
It never starts a show and never touches output, which is exactly why all four transports
(raw query, URL-encoded query, REST POST, WebSocket) returned HTTP 204 with no visible effect.

It is not a transport problem and URL encoding is not the issue.

Additional finding: with **no project open**, every `*_project_item` action is a silent no-op,
because FreeShow resolves items from `projects[activeProject]`.

## What does put content on screen (verified)

Measured with `get_output_slide_text` before/after each call:

| Call | Effect |
| --- | --- |
| `clear_all` | output text becomes empty ✅ |
| `start_show {id}` | first slide of that show goes live, even if the show is **not** in a project ✅ |
| `next_slide` | advances within the live show ✅ |
| `set_plain_text {id, value}` | rewrites the show's text; **if that show is already live the output updates immediately**, no re-transition ✅ |
| `index_select_slide {index, showId}` | accepted but did not change the live slide in our test — treat as unreliable ⚠️ |
| `start_scripture {reference}` | no effect: FreeShow has **no Bible installed** (`Documents/FreeShow/Bibles` is empty) ❌ |

### The live path this app uses

1. Resolve one dedicated show named **“Live Scripture”** via `get_shows` (create it once with
   `create_show` if missing).
2. `set_plain_text {id, value}` with the verse text + reference line.
3. `start_show {id}` — only when that show is not already the live one.
4. `next_slide` to walk additional slides of a long passage.
5. Verify with `get_output_slide_text`; fall back to `clear_all` → `start_show` → `index_select_slide`
   if the text never appears.

## Updating a slide that is already live

`set_show` replaces the show data (`get_show` shows the new text) but the output window keeps
painting the copy it resolved when the show went live, so the projector stays on the old frame.
Measured on 2026-11-19:

| Call after `set_show` | Visible effect |
| --- | --- |
| `start_show {id}` while already live | none (same slide id/index is not re-resolved) |
| `next_slide` then `previous_slide` | re-renders the live slide from the current data ✅ |
| `clear_all` | output goes black ✅ |
| a layout slide with `transition: {type:"none",duration:0}` | **blocks** `next_slide`/`previous_slide` |

So the app writes the show with `set_show` and then steps to a second (identical) slide and back,
which is why every built show carries a twin slide.

Text sizing is stored, not recalculated for output: `growToFit` blows short text up to fill the box
and overflows the projector, and `shrinkToFit`/`autoFontSize` only matter in the editor. The adapter
computes the px size itself (`fitFontSize`, ~0.66 x font size per character, ~1.95x font size per
line) and writes it both into the span style and `autoFontSize`.

One output window on this PC stopped repainting slide content entirely during testing (black on
`clear_all`, but no slide ever appeared again, even for FreeShow's own `set_plain_text`). Restarting
FreeShow cleared it; it is a FreeShow output-window problem, not an API one.

## Output window on/off (Start / Stop output)

Measured on 2026-11-20 against the restarted FreeShow:

| Call | Effect |
| --- | --- |
| `toggle_output_windows` | FreeShow's **Present** button: shows the output window(s), or hides them if they are showing |
| `restore_output` | puts back the layers `clear_all` removed |
| `get_output` | still returns `{slide, background, transition, overlays, effects}` — **no visibility flag**, identical whether the window is shown or hidden |

Because the API cannot report it, the app asks Windows: `scripts/output-windows.ps1` enumerates the
FreeShow process' top-level windows and treats any *visible* window not titled `FreeShow` (the main
editor) as the live output. On this PC the output window is titled `Primary`. Hiding it leaves the
window existing but `IsWindowVisible = false`, so the check is reliable in both directions.

`toggle_output_windows` is fire-and-forget (HTTP 204, no reply); the window state settles within
~0.5 s, so read the state back after a short wait. Do not call it twice as a "reset" — that just
toggles the window back off. Also avoid unknown `get_*` actions (`get_outputs`, `get_displays`, …):
they are accepted silently and then never answer, so a request waits for the full timeout.

## Traps found the hard way

- **`create_show` appends the new show to the open project.** Creating the scratch show leaves one
  extra row (“Live Scripture”) in the service project. Delete that row in FreeShow once.
- **`remove_project_item {id, index}` splices the internal array by index**, and that order does not
  match `get_projects` output. Removing index 4 deleted a different song from the project. The app
  therefore never removes project rows.
- **`add_to_project` only appends** (`{projectId, id, data?}`), with no position control, so a
  removed item cannot be restored to its original slot by API.
- `set_template {id}` applies to the selected show and accepts built-in ids such as `default`.
- Output state is also readable: `get_output` → `data.slide {id, layout, index, line, projectIndex}`.

## File formats (read directly, never written)

### Song: `Documents/FreeShow/Shows/<Name>.show`

```jsonc
["CCLI-4437217", {
  "name": "All My Praise",
  "category": "easyworship",
  "settings": { "activeLayout": "fd032863e74", "template": "default" },
  "slides": {
    "d032863e741": {
      "group": "Chorus", "color": "#f525d2",
      "items": [
        { "style": "top:88px;left:50px;height:904px;width:1820px;",
          "lines": [{ "align": "", "text": [{ "style": "font-size:80px;", "value": "Holy my God" }] }] }
      ],
      "globalGroup": "chorus"
    }
  },
  "layouts": { "fd032863e74": { "name": "Default", "slides": [{ "id": "d032863e741" }] } },
  "media": {}
}]
```

- Top level is a two-element array: `[showId, show]`.
- Verse order comes from `layouts[activeLayout].slides[].id`.
- The lyric lives in the **first text item**; songs imported with split screens carry a second
  item holding the scripture reference/quote (see God Of Wonders in the project export).
- Library index: `Documents/FreeShow/shows.json` (keyed by show id).

### Project export: `*.project`

```jsonc
{
  "project": { "id": "31a7120d442", "name": "11/07/26", "shows": [{ "id": "CCLI-3118757", "index": 0 }] },
  "shows": { "CCLI-3118757": { /* same show shape as above */ } },
  "categories": { "easyworship": { "name": "EasyWorship", "icon": "song" } },
  "files": []
}
```

Project membership lives in `Documents/FreeShow/Config/projects.json`.

### Templates: `Documents/FreeShow/Config/templates.json`

Keyed by id. The scripture presets use placeholders:

```
{scripture_number}  {scripture_text}  {scripture_reference}  {scripture_name}
```

The split-screen look used by the songs comes from template `c772a9b50b0` (“Default”, category
`song`): item 1 = lyrics on the left, item 2 = scripture reference + quote on the right, items 3–4
= header text boxes. The user’s project slides already carry that structure per slide, which is
what bulk-prep must clone — the template file itself is never modified.

## Environment facts

- FreeShow data: `%APPDATA%/FreeShow` (cache/settings/shows index) and `Documents/FreeShow`
  (media, shows, config, exports) — custom user data location is enabled.
- `settings.json` → `serverData.companion.enabled = true` (the API switch), ports 5505/5506 default,
  remote/stage servers on 5510/5511.
- 60+ songs in the library, one project (“11/07/26”) with 6 songs, one CCLI-tagged metadata block per song.
