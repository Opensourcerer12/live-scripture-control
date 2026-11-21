/**
 * Readiness checks: "is this PC ready to run the app?"
 *
 * Shared by `scripts/doctor.mjs` (printed in a console) and the desktop app's
 * File → Check setup menu item. Read-only: nothing here changes FreeShow, the config
 * or the app's state.
 */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { execFile } from "node:child_process"
import { DATA_DIR, loadConfig, lanAddresses } from "./config.mjs"
import { listSongs } from "./library.mjs"
import { outputWindows } from "./winoutput.mjs"

function portOpen(port, host, timeout = 1500) {
	return new Promise((resolve) => {
		const socket = net.connect({ port, host })
		const finish = (value) => {
			socket.destroy()
			resolve(value)
		}
		socket.setTimeout(timeout)
		socket.once("connect", () => finish(true))
		socket.once("timeout", () => finish(false))
		socket.once("error", () => finish(false))
	})
}

function screenCount() {
	if (process.platform !== "win32") return Promise.resolve(0)
	const command = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens.Count"
	return new Promise((resolve) => {
		execFile("powershell", ["-NoProfile", "-Command", command], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
			const count = Number(String(stdout || "").trim())
			resolve(err || !Number.isFinite(count) ? 0 : count)
		})
	})
}

export async function runChecks() {
	const lines = []
	let problems = 0

	const ok = (msg) => lines.push(`ok      ${msg}`)
	const warn = (msg) => {
		problems++
		lines.push(`CHECK   ${msg}`)
	}
	const note = (msg) => lines.push(`        ${msg}`)

	const config = loadConfig()

	const major = Number(process.versions.node.split(".")[0])
	if (major >= 18) ok(`Node.js ${process.version}`)
	else warn(`Node.js ${process.version} is too old — install the LTS build from nodejs.org (18 or newer)`)

	const songs = listSongs(config.showsDir)
	if (songs.error) {
		warn(`song library: ${songs.error}`)
		note('fix "showsDir" in config.json, or run: node scripts/new-pc.mjs')
	} else if (!songs.songs.length) {
		warn(`${config.showsDir} contains no .show files — FreeShow's song library looks empty`)
	} else {
		ok(`${songs.songs.length} songs read from ${config.showsDir}`)
	}

	const bible = path.join(DATA_DIR, "kjv.json")
	if (fs.existsSync(bible)) ok(`KJV Bible present (${(fs.statSync(bible).size / 1048576).toFixed(1)} MB, offline)`)
	else warn("the KJV Bible file is missing — no verse text can be looked up")

	const restOpen = await portOpen(config.freeshow.restPort, config.freeshow.host)
	const httpOpen = await portOpen(config.freeshow.httpPort, config.freeshow.host)
	if (restOpen && httpOpen) ok(`FreeShow API answering on ${config.freeshow.host} (${config.freeshow.httpPort}/${config.freeshow.restPort})`)
	else {
		warn(`FreeShow API not answering on ${config.freeshow.host} (${config.freeshow.httpPort}/${config.freeshow.restPort})`)
		note("start FreeShow and enable Connections → API in its settings")
	}

	const windows = await outputWindows()
	if (!windows.ok) note(`output window: ${windows.error || "could not be checked"}`)
	else if (windows.visible) ok("FreeShow output window is visible")
	else {
		warn("FreeShow output window is not visible — nothing is on the projector")
		note('click "Present" in FreeShow, or "Start output" in the app')
	}

	const screens = await screenCount()
	if (screens > 1) ok(`${screens} displays detected — put FreeShow's output on the projector, keep the app on the PC screen`)
	else if (screens === 1) {
		warn("only one display detected — the projector is probably duplicating the PC screen")
		note("press Win+P and choose Extend, so mistakes are not shown to the congregation")
	} else note("display count could not be read (not Windows, or no desktop session)")

	const paired = Array.isArray(config.tokens) ? config.tokens.length : 0
	ok(`phone PIN ${config.pin}, ${paired} paired phone(s)`)
	const lan = lanAddresses()
	if (lan.length) ok(`phone URL http://${lan[0]}:${config.appPort}/phone`)
	else warn("no network address found — the phone remote will not work on this network")

	return { lines, problems }
}
