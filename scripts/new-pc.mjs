/**
 * Prepare a copy of this app for a different PC.
 *
 *   node scripts/new-pc.mjs        (run it with the app stopped)
 *
 * A config.json copied from another PC brings that PC's song-library path, PIN and paired
 * phones with it. This points showsDir at this machine, issues a fresh PIN and clears the
 * pairing. Pinned scriptures (data/verse-bindings.json) and the suggestion cache are kept —
 * they are keyed by FreeShow show ids, so they stay valid as long as the song library is
 * the same one.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { ROOT, DATA_DIR } from "../server/config.mjs"

const CONFIG = path.join(ROOT, "config.json")
const changes = []
const notes = []

let config = {}
try {
	config = JSON.parse(fs.readFileSync(CONFIG, "utf8"))
} catch {
	config = {}
}

const homeShows = path.join(os.homedir(), "Documents", "FreeShow", "Shows")
if (!config.showsDir || !fs.existsSync(config.showsDir)) {
	if (config.showsDir) changes.push(`showsDir now ${homeShows} (was ${config.showsDir}, not on this PC)`)
	else changes.push(`showsDir now ${homeShows}`)
	config.showsDir = homeShows
	if (!fs.existsSync(homeShows)) notes.push(`${homeShows} does not exist yet — start FreeShow once so it creates it`)
}

const previousPin = config.pin
config.pin = String(crypto.randomInt(1000, 10000))
changes.push(`new phone PIN ${config.pin}${previousPin ? ` (was ${previousPin})` : ""}`)

const paired = Array.isArray(config.tokens) ? config.tokens.length : 0
config.tokens = []
changes.push(`cleared ${paired} paired phone(s) from the previous PC`)

fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2))

const session = path.join(DATA_DIR, "session.json")
if (fs.existsSync(session)) {
	fs.rmSync(session)
	changes.push("cleared data/session.json (the song/verse that was on screen)")
}

console.log("")
console.log("  Prepared config.json for this PC")
console.log("")
for (const change of changes) console.log(`  - ${change}`)
for (const note of notes) console.log(`  ! ${note}`)
console.log("")
console.log("  Kept: pinned scriptures (data/verse-bindings.json), suggestion cache, KJV Bible.")
console.log('  Next: double-click "Check setup.cmd", then "Start Live Scripture.cmd".')
console.log("")
