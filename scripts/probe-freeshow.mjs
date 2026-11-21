#!/usr/bin/env node
/**
 * STEP 0 probe for FreeShow's local API.
 *
 * Answers, with evidence rather than guesses:
 *   - which transports are listening (HTTP query on 5505, REST POST on 5506, socket.io on 5505)
 *   - which actions actually change what is on screen, verified through FreeShow's
 *     own get_output / get_output_slide_text state endpoints
 *
 * Usage:
 *   node scripts/probe-freeshow.mjs
 *   node scripts/probe-freeshow.mjs --host=127.0.0.1 --http=5505 --rest=5506 --ws=5505
 *
 * Safety: only uses actions that are reversible (clear_all at the very end leaves
 * the screen blank). It never writes files or edits your songs.
 */

import { io } from "socket.io-client"

const argv = process.argv.slice(2)
const arg = Object.fromEntries(
	argv.map((a) => {
		const [k, ...rest] = a.replace(/^--/, "").split("=")
		return [k, rest.length ? rest.join("=") : true]
	})
)

const HOST = arg.host || "127.0.0.1"
const HTTP_PORT = Number(arg.http || 5505)
const REST_PORT = Number(arg.rest || 5506)
const WS_PORT = Number(arg.ws || 5505)
const TIMEOUT = 4000

const base = (port) => `http://${HOST}:${port}/`

function parseBody(text) {
	if (!text) return null
	try {
		return JSON.parse(text)
	} catch {
		return text.slice(0, 400)
	}
}

/** REST: POST JSON body { action, ...data } to port 5506 (FreeShow's REST listener). */
async function rest(payload, port = REST_PORT) {
	const res = await fetch(base(port), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(TIMEOUT)
	})
	return { status: res.status, body: parseBody(await res.text()) }
}

/** HTTP: GET/POST ?action=X&data={json} to port 5505 (FreeShow's HTTP action route). */
async function http(payload, { encode = false, port = HTTP_PORT } = {}) {
	const raw = JSON.stringify(payload)
	const data = encode ? encodeURIComponent(raw) : raw
	const url = `${base(port)}?action=${encodeURIComponent(payload.action)}&data=${data}`
	const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(TIMEOUT) })
	return { status: res.status, body: parseBody(await res.text()) }
}

/** WebSocket: socket.io on 5505, emit "data" with a JSON string { action, ...data }. */
function ws(payload, waitMs = 700) {
	return new Promise((resolve) => {
		let connected = false
		let reply = null
		let error = null
		let socket
		try {
			socket = io(base(WS_PORT).replace(/\/$/, ""), {
				transports: ["websocket"],
				reconnection: false,
				timeout: TIMEOUT
			})
		} catch (err) {
			resolve({ connected: false, reply: null, error: String(err) })
			return
		}
		socket.on("connect", () => {
			connected = true
			socket.emit("data", JSON.stringify(payload))
		})
		socket.on("data", (d) => (reply = d))
		socket.on("error", (e) => (error = String(e)))
		socket.on("connect_error", (e) => (error = String(e?.message || e)))
		setTimeout(() => {
			socket.close()
			resolve({ connected, reply, error })
		}, waitMs)
	})
}

/** What is actually live on the output right now. */
async function liveState() {
	const out = await rest({ action: "get_output" })
	const text = await rest({ action: "get_output_slide_text" })
	const o = out.body || {}
	const slide = o?.out?.slide || null
	return {
		ok: out.status === 200,
		showId: slide?.id || null,
		layoutId: slide?.layout || null,
		slideIndex: slide?.index ?? null,
		outputText: typeof text.body === "string" ? text.body : JSON.stringify(text.body || null),
		raw: o
	}
}

function signature(s) {
	if (!s.ok) return "no-get_output"
	if (!s.showId) return "BLANK"
	return `${s.showId}/${s.layoutId}/${s.slideIndex}`
}

function short(v, n = 220) {
	const s = typeof v === "string" ? v : JSON.stringify(v)
	if (!s) return String(v)
	return s.length > n ? s.slice(0, n) + "…" : s
}

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Run one action and record whether the live output changed.
 * "changed" is the only proof that an action reaches the screen.
 */
async function trial(name, transport, fn, { settle = 600, expect } = {}) {
	let before, after, result, err
	try {
		before = await liveState()
		result = await fn()
		await sleep(settle)
		after = await liveState()
	} catch (e) {
		err = String(e?.message || e)
	}
	const beforeSig = before ? signature(before) : "?"
	const afterSig = after ? signature(after) : "?"
	const changed = beforeSig !== afterSig
	const row = {
		name,
		transport,
		status: result?.status ?? result?.reply ?? (err ? "ERROR" : "n/a"),
		before: beforeSig,
		after: afterSig,
		changed,
		expect,
		error: err || result?.error || null,
		text: short(after?.outputText || "")
	}
	results.push(row)
	const verdict = err ? "ERROR" : changed ? "WORKS" : "no effect"
	console.log(`\n[${verdict}] ${name}  (${transport})`)
	console.log(`   status : ${short(row.status)}`)
	console.log(`   before : ${beforeSig}`)
	console.log(`   after  : ${afterSig}`)
	console.log(`   on air : ${row.text}`)
	if (row.error) console.log(`   error  : ${short(row.error)}`)
	return row
}

async function main() {
	console.log("FreeShow API probe")
	console.log(`  host ${HOST}  http ${HTTP_PORT}  rest ${REST_PORT}  ws ${WS_PORT}`)

	// ---- reachability -------------------------------------------------------
	console.log("\n=== reachability ===")
	for (const [label, url] of [
		[`http:${HTTP_PORT}`, base(HTTP_PORT)],
		[`rest:${REST_PORT}`, base(REST_PORT)]
	]) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) })
			console.log(`  ${label} -> HTTP ${res.status}`)
		} catch (e) {
			console.log(`  ${label} -> unreachable (${e?.message || e})`)
		}
	}
	const sock = await ws({ action: "get_output" }, 900)
	console.log(`  ws:${WS_PORT} -> ${sock.connected ? "connected" : "NOT connected"}${sock.error ? ` (${sock.error})` : ""}`)

	// ---- read-only inventory ------------------------------------------------
	console.log("\n=== inventory (read-only) ===")
	const projects = await rest({ action: "get_projects" })
	const projectList = Array.isArray(projects.body) ? projects.body : []
	console.log(`  get_projects -> HTTP ${projects.status}, ${projectList.length} project(s)`)
	const project = projectList[0]
	const projectId = project?.id
	let items = []
	if (projectId) {
		const p = await rest({ action: "get_project", id: projectId })
		items = p.body?.shows || p.body?.items || []
		console.log(`  active project "${project?.name || projectId}" -> ${items.length} item(s)`)
		items.slice(0, 8).forEach((it, i) => console.log(`     [${i}] ${it?.id} ${it?.type ? `(${it.type})` : ""}`))
	}
	const shows = await rest({ action: "get_shows" })
	console.log(`  get_shows -> HTTP ${shows.status}, ${Array.isArray(shows.body) ? shows.body.length : "?"} show(s)`)
	const baseline = await liveState()
	console.log(`  live output -> ${signature(baseline)}  "${short(baseline.outputText, 120)}"`)

	// ---- the four transports for the same action ----------------------------
	console.log("\n=== index_select_project_item: every transport ===")
	if (items.length > 1) {
		// move away first so the index select has something to do
		await rest({ action: "index_select_project_item", index: 0 }).catch(() => {})
		await sleep(500)
	}
	await trial("index_select_project_item index=1", "HTTP raw", () => http({ action: "index_select_project_item", index: 1 }), { expect: "item highlighted" })
	await trial("index_select_project_item index=0", "HTTP urlencoded", () => http({ action: "index_select_project_item", index: 0 }, { encode: true }), { expect: "item highlighted" })
	await trial("index_select_project_item index=1", "REST POST", () => rest({ action: "index_select_project_item", index: 1 }), { expect: "item highlighted" })
	await trial("index_select_project_item index=0", "WebSocket", () => ws({ action: "index_select_project_item", index: 0 }), { expect: "item highlighted" })

	// does selecting + starting the item put it on screen?
	if (items.length) {
		const target = items[Math.min(1, items.length - 1)]
		console.log(`\n=== start_show on project item id ${target?.id} ===`)
		await trial("start_show (project item 2)", "REST POST", () => rest({ action: "start_show", id: target.id }), { expect: "puts first slide of that show on screen", settle: 900 })
		await trial("index_select_slide 0 after start_show", "REST POST", () => rest({ action: "index_select_slide", index: 0, showId: target.id }), { expect: "puts slide 1 on screen", settle: 900 })
	}

	// ---- project navigation -------------------------------------------------
	console.log("\n=== project navigation ===")
	await trial("next_project_item", "REST POST", () => rest({ action: "next_project_item" }), { expect: "advances output (confirmed by user)", settle: 900 })
	await trial("previous_project_item", "REST POST", () => rest({ action: "previous_project_item" }), { expect: "goes back one output item", settle: 900 })
	await trial("next_project_item", "HTTP query", () => http({ action: "next_project_item" }), { expect: "same effect over 5505", settle: 900 })

	// ---- scripture action (FreeShow's own Bible) ----------------------------
	console.log("\n=== start_scripture (needs a Bible installed in FreeShow) ===")
	await trial("start_scripture John 3:16", "REST POST", () => rest({ action: "start_scripture", reference: "John 3:16" }), { expect: "only works with a Bible installed", settle: 1200 })

	// ---- clear --------------------------------------------------------------
	console.log("\n=== clear ===")
	await trial("clear_all", "REST POST", () => rest({ action: "clear_all" }), { expect: "blanks output", settle: 700 })
	const finalState = await liveState()
	console.log(`\nfinal live output: ${signature(finalState)}`)

	// ---- summary ------------------------------------------------------------
	console.log("\n================ SUMMARY ================")
	for (const r of results) {
		const mark = r.error ? "ERR " : r.changed ? "OK  " : ".   "
		console.log(`${mark} ${r.name.padEnd(42)} ${String(r.transport).padEnd(15)} ${r.before} -> ${r.after}`)
	}
	const works = results.filter((r) => r.changed && !r.error).map((r) => r.name)
	console.log("\nActions proven to reach the screen:")
	works.forEach((w) => console.log(`  - ${w}`))
	if (!works.length) console.log("  (none)")
	console.log("\nNote: index_select_project_item selects a row in the project list only.")
	console.log("To place a specific show on screen use start_show {id} then index_select_slide {index}.")
	process.exit(0)
}

main().catch((e) => {
	console.error("probe failed:", e)
	process.exit(1)
})
