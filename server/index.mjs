import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { WebSocketServer } from "ws"

import { PUBLIC_DIR, DATA_DIR, loadConfig, saveConfig, readJson, writeJson, lanAddresses } from "./config.mjs"
import { FreeShow } from "./freeshow.mjs"
import { outputWindows } from "./winoutput.mjs"
import { listSongs, getSong } from "./library.mjs"
import { lookup, availableTranslations, preview } from "./bible.mjs"
import { suggest } from "./suggestions.mjs"

const config = loadConfig()
const freeshow = new FreeShow(() => config)

const SESSION_FILE = path.join(DATA_DIR, "session.json")
const saved = readJson(SESSION_FILE, {})

// Scripture pinned to one song verse: "<songId>::<verseIndex>" -> { reference, text, translation, at }
const BINDINGS_FILE = path.join(DATA_DIR, "verse-bindings.json")
const bindings = readJson(BINDINGS_FILE, {})
const bindingKey = (songId, verseIndex) => `${songId}::${Number(verseIndex)}`
const saveBindings = () => writeJson(BINDINGS_FILE, bindings)

const state = {
	current: saved.current || null,
	suggestions: [],
	suggestionsFor: saved.suggestionsFor || "",
	manual: saved.manual || null,
	live: null, // read from FreeShow on boot, not restored from the session file
	output: null, // whether FreeShow's output window is visible (checked on demand)
	translation: saved.translation || config.translation || "KJV",
	locked: typeof saved.locked === "boolean" ? saved.locked : !!config.locked
}

let songs = []
let songsError = null
let health = { ok: false, error: "not checked yet" }

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isLocalAddress = (address) => {
	const addr = String(address || "")
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
}

const tokenOf = (req, url) => String(req.headers["x-slc-token"] || url?.searchParams.get("token") || "")

function authorized(req, url) {
	if (isLocalAddress(req.socket.remoteAddress)) return true
	const token = tokenOf(req, url)
	return !!token && Array.isArray(config.tokens) && config.tokens.includes(token)
}

function lanUrls() {
	return lanAddresses().map((address) => `http://${address}:${config.appPort}`)
}

let saveTimer = null
function saveSession() {
	if (saveTimer) clearTimeout(saveTimer)
	saveTimer = setTimeout(() => {
		saveTimer = null
		writeJson(SESSION_FILE, {
			current: state.current,
			manual: state.manual,
			live: state.live,
			translation: state.translation,
			locked: state.locked
		})
	}, 300)
}

function refreshSongs() {
	const result = listSongs(config.showsDir)
	songs = result.songs
	songsError = result.error
	return result
}

function bindingItem(current) {
	const binding = bindings[bindingKey(current.songId, current.verseIndex)]
	if (!binding) return null
	const resolved = lookup(state.translation, binding.reference)
	return {
		reference: resolved?.ok ? resolved.reference : binding.reference,
		text: resolved?.ok ? resolved.text : "",
		theme: "Pinned",
		translation: resolved?.ok ? resolved.translation : binding.translation,
		bound: true
	}
}

function refreshSuggestions() {
	const current = state.current
	if (!current) {
		state.suggestions = []
		return
	}
	const generated = suggest({
		text: current.verseText,
		context: `${current.songName} ${current.group || ""}`,
		translation: state.translation,
		limit: 5
	})
	const pinned = bindingItem(current)
	if (!pinned) {
		state.suggestions = generated
		return
	}
	const pinnedRef = pinned.reference.toLowerCase()
	state.suggestions = [pinned, ...generated.filter((item) => item.reference.toLowerCase() !== pinnedRef)].slice(0, 5)
}

function publicState({ includePin = false } = {}) {
	const payload = {
		translation: state.translation,
		translations: availableTranslations(),
		locked: state.locked,
		current: state.current,
		manual: state.manual,
		suggestions: state.suggestions,
		suggestionsFor: state.suggestionsFor,
		// Only offer "pin to this verse" when the cards really are that verse's suggestions
		// (after loading a manual reference they are not, and pinning would hit the old verse).
		pinTarget: state.current && state.suggestionsFor === state.current.label ? { songId: state.current.songId, verseIndex: state.current.verseIndex } : null,
		output: state.output,
		bindings,
		binding: state.current ? bindings[bindingKey(state.current.songId, state.current.verseIndex)] || null : null,
		live: state.live,
		freeshow: health,
		songs: songs.filter((song) => song.name !== config.freeshow.showName).map((song) => ({ id: song.id, name: song.name, verseCount: song.verses.length })),
		songsError,
		clients: wss ? wss.clients.size : 0
	}
	if (includePin) {
		payload.pin = config.pin
		payload.showName = config.freeshow.showName
		payload.urls = { local: `http://localhost:${config.appPort}`, lan: lanUrls() }
		payload.endpoints = { host: config.freeshow.host, httpPort: config.freeshow.httpPort, restPort: config.freeshow.restPort }
		payload.showsDir = config.showsDir
	}
	return payload
}

function broadcast() {
	if (!wss) return
	for (const client of wss.clients) {
		if (client.readyState !== 1 || !client.authorizedSocket) continue
		client.send(JSON.stringify({ type: "state", state: publicState({ includePin: !!client.isLocal }) }))
	}
}

function setLive(live) {
	state.live = live
	saveSession()
}

async function checkHealth({ silent = true } = {}) {
	const before = health
	health = await freeshow.health()
	const changed = before?.ok !== health.ok || before?.transport !== health.transport
	if (!silent && changed) broadcast()
	return health
}

// ---------------------------------------------------------------- actions

const VERSE_REF_RE = /^\s*([1-3]?\s*[a-z][a-z.'’\s]*?)\s*(\d{1,3})(?:\s*[:.]\s*(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?)?\s*$/i

function inferReference(text) {
	const full = String(text || "").trim()
	if (!full) return null
	// FreeShow's live text may start with the reference on its own line, or embed it.
	const firstLine = full.split(/[\r\n]/)[0]?.trim() || ""

	// If the visible text already begins with a reference like "Psalms 46:1", use it.
	const m = firstLine.match(VERSE_REF_RE)
	if (m) {
		const [, book, chapter, verse] = m
		if (book && chapter) {
			const cs = (v) => (v ? `:${v}` : "")
			if (verse) return `${book.trim()} ${chapter}${cs(verse)}`
			return `${book.trim()} ${chapter}`
		}
	}

	// Otherwise look for the first reference anywhere in the text.
	const snippet = full.slice(0, 400)
	const hit = snippet.match(VERSE_REF_RE)
	if (hit) {
		const [, book, chapter, verse] = hit
		if (book && chapter) {
			const cs = (v) => (v ? `:${v}` : "")
			return `${book.trim()} ${chapter}${cs(verse)}`
		}
	}

	return null
}

function normalizeVerseText(t) {
	return String(t || "").replace(/\s+/g, " ").trim()
}

async function currentScreenVerseType() {
	const live = await freeshow.live()
	if (!live?.ok) return { ok: false }
	if (!live.showId) return { ok: false, kind: "not-our-show" }
	const lower = String(live.showId).toLowerCase()
	if (lower === config.freeshow.showName.toLowerCase() || lower === "6b287008d27") return { ok: true, kind: "our-show", text: live.text }
	return { ok: true, kind: "other-real-show", showId: live.showId, text: live.text }
}

async function songCandidateFor(text) {
	const shown = normalizeVerseText(text)
	if (!shown) return null
	refreshSongs()
	const shownLower = shown.toLowerCase()
	for (const song of songs) {
		for (const verse of song.verses) {
			const vText = normalizeVerseText(verse.text)
			if (vText === shown) return { song, verse }
			if (shownLower.startsWith(vText.slice(0, 120).toLowerCase()) || vText.startsWith(shownLower.slice(0, 120).toLowerCase())) {
				return { song, verse }
			}
		}
	}
	return null
}

async function restoreFromFreeShow() {
	const screen = await currentScreenVerseType()
	if (!screen.ok) {
		// FreeShow unreachable (or no slide id): don't invent a live verse.
		state.live = null
		if (state.current) {
			state.suggestionsFor = state.suggestionsFor || `${state.current.songName} · ${state.current.group || "Verse"}`
			refreshSuggestions()
		} else if (state.manual) {
			state.suggestionsFor = state.suggestionsFor || state.manual.reference
			refreshSuggestions()
		}
		saveSession()
		return
	}

	if (screen.kind === "not-our-show") {
		// FreeShow has no output slide: nothing of ours is live.
		state.live = null
		if (state.current) {
			state.suggestionsFor = state.suggestionsFor || `${state.current.songName} · ${state.current.group || "Verse"}`
			refreshSuggestions()
		} else if (state.manual) {
			state.suggestionsFor = state.suggestionsFor || state.manual.reference
			refreshSuggestions()
		}
		saveSession()
		return
	}

	// The Live Scripture show is up: recover which verse it carries from its text.
	if (screen.kind === "our-show") {
		const ref = inferReference(screen.text)
		const shown = normalizeVerseText(screen.text)
		state.live = shown ? { reference: ref, text: shown, translation: state.translation, restoredFromFreeShow: true, at: Date.now() } : null
		saveSession()
		const match = await songCandidateFor(shown)
		if (match) {
			state.current = { songId: match.song.id, songName: match.song.name, verseIndex: match.verse.index, group: match.verse.group, verseText: match.verse.text, label: `${match.song.name} · ${match.verse.group || "Verse"}` }
			state.suggestionsFor = `${match.song.name} · ${match.verse.group || "Verse"}`
			refreshSuggestions()
			saveSession()
		} else {
			// Our show is live but we can't map it back to a song verse:
			// keep the app's last selection (don't clobber) and just refresh.
			if (state.current) {
				state.suggestionsFor = state.suggestionsFor || `${state.current.songName} · ${state.current.group || "Verse"}`
				refreshSuggestions()
			} else {
				state.suggestionsFor = ref || state.suggestionsFor || ""
			}
			saveSession()
		}
		return
	}

	// Some other real FreeShow show is on screen: our scripture isn't live.
	state.live = null
	if (state.current) {
		state.suggestionsFor = state.suggestionsFor || `${state.current.songName} · ${state.current.group || "Verse"}`
		refreshSuggestions()
	} else if (state.manual) {
		state.suggestionsFor = state.suggestionsFor || state.manual.reference
		refreshSuggestions()
	}
	saveSession()
}

// ---------------------------------------------------------------- actions: select / show / manual / clear

async function selectVerse(body, { canDisplay = true } = {}) {
	const songId = String(body?.songId || "")
	const verseIndex = Number(body?.verseIndex)
	const song = getSong(config.showsDir, songId)
	if (!song) throw httpError(404, "Song not found")
	const verse = (song.verses || []).find((v) => v.index === verseIndex)
	if (!verse) throw httpError(404, "Verse not found")
	state.current = {
		songId: song.id,
		songName: song.name,
		verseIndex: verse.index,
		group: verse.group,
		verseText: verse.text,
		label: `${song.name} · ${verse.group || "Verse"}`
	}
	state.suggestionsFor = state.current.label
	refreshSuggestions()
	saveSession()

	// Clicking a verse puts a scripture on screen: the one pinned to it, else the top suggestion.
	const pinned = bindings[bindingKey(song.id, verse.index)]
	const target = pinned?.reference || state.suggestions[0]?.reference || null
	let sent = null
	let sendError = null
	if (target && canDisplay) {
		try {
			const result = await showReference(target)
			sent = { reference: result.reference, verified: !!result.verified }
		} catch (err) {
			sendError = err?.message || String(err)
		}
	}

	broadcast()
	return { current: state.current, suggestions: state.suggestions, target, sent, sendError }
}

async function showReference(reference) {
	const input = String(reference || "").trim()
	if (!input) throw httpError(400, "Missing reference")

	let refLabel = input
	let passageText = input
	const resolved = lookup(state.translation, input)
	if (resolved?.ok) {
		refLabel = resolved.reference
		passageText = resolved.text
	}

	let displayResult
	try {
		displayResult = await freeshow.display({
			reference: refLabel,
			text: passageText,
			translation: state.translation,
			songId: state.current?.songId || null,
			verseIndex: state.current?.verseIndex ?? 0
		})
	} catch (err) {
		throw httpError(502, err?.message || String(err))
	}

	setLive({ reference: refLabel, text: passageText, translation: state.translation, verified: !!displayResult?.verified, at: Date.now() })
	saveSession()
	broadcast()
	return {
		ok: !!displayResult?.ok,
		verified: !!displayResult?.verified,
		verification: { verified: !!displayResult?.verified },
		path: displayResult?.path,
		showId: displayResult?.showId,
		transport: displayResult?.transport,
		live: state.live,
		reference: refLabel
	}
}

async function setManual(reference) {
	const input = String(reference || "").trim()
	if (!input) throw httpError(400, "Missing reference")
	const resolved = lookup(state.translation, input)
	if (!resolved?.ok) throw httpError(400, resolved?.error || "Could not read reference")
	state.manual = { reference: resolved.reference, text: resolved.text, translation: state.translation }
	state.suggestionsFor = resolved.reference
	refreshSuggestions()
	saveSession()
	broadcast()
	return { manual: state.manual, suggestions: state.suggestions }
}

let outputCheck = { at: 0, value: null }
async function refreshOutputWindows({ maxAge = 1500 } = {}) {
	if (outputCheck.value && Date.now() - outputCheck.at < maxAge) return outputCheck.value
	const result = await outputWindows()
	outputCheck = { at: Date.now(), value: result }
	state.output = { ok: !!result.ok, visible: !!result.visible, windows: result.windows || [], error: result.error || null, at: Date.now() }
	return result
}

async function clearScreen() {
	try {
		await freeshow.clear()
	} catch (err) {
		throw httpError(502, err?.message || String(err))
	}
	setLive(null)
	saveSession()
	broadcast()
	return { ok: true, cleared: true }
}

// ---------------------------------------------------------------- CORS preflight / origin checks

function requestOrigin(req) {
	// browsers send Origin on the POST request itself (not just the preflight).
	const h = String(req.headers.origin || req.headers.referrer || "")
	try { return new URL(h).origin } catch { return "" }
}

function allowedOrigins() {
	const origins = new Set()
	for (const host of ["localhost", "127.0.0.1"]) {
		origins.add(`http://${host}:${config.appPort}`)
		origins.add(`https://${host}:${config.appPort}`)
	}
	for (const entries of Object.values(os.networkInterfaces()) || []) {
		for (const net of entries || []) {
			if (net.family === "IPv4" && !net.internal) {
				origins.add(`http://${net.address}:${config.appPort}`)
				origins.add(`https://${net.address}:${config.appPort}`)
			}
		}
	}
	return origins
}

function originAllowed(req) {
	const origin = requestOrigin(req)
	// No Origin header: allow only genuine local requests (curl, local process).
	if (!origin) return isLocalAddress(req.socket.remoteAddress)
	// Origin present: must be one of this app's own origins.
	return allowedOrigins().has(origin)
}

// ---------------------------------------------------------------- http

function httpError(status, message) {
	const err = new Error(message)
	err.status = status
	return err
}

function sendJson(res, status, body) {
	const data = JSON.stringify(body)
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(data) })
	res.end(data)
}

function sendCorsError(res, status, message) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"access-control-allow-origin": "null",
		"content-length": Buffer.byteLength(JSON.stringify({ error: message }))
	})
	res.end(JSON.stringify({ error: message }))
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let body = ""
		req.on("data", (chunk) => {
			body += chunk
			if (body.length > 1_000_000) {
				reject(httpError(413, "Request body too large"))
				req.destroy()
			}
		})
		req.on("end", () => {
			if (!body) return resolve({})
			try {
				resolve(JSON.parse(body))
			} catch {
				reject(httpError(400, "Invalid JSON body"))
			}
		})
		req.on("error", reject)
	})
}

const MIME = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json"
}

function serveStatic(req, res, url) {
	let rel = url.pathname
	if (rel === "/") rel = "/index.html"
	else if (rel === "/phone" || rel === "/phone/") rel = "/phone.html"
	if (rel.includes("..")) return sendJson(res, 400, { error: "Bad path" })

	const file = path.join(PUBLIC_DIR, rel)
	if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden" })

	fs.readFile(file, (err, data) => {
		if (err) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
			return res.end("Not found")
		}
		res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" })
		res.end(data)
	})
}

async function handleApi(req, res, url) {
	const route = url.pathname.replace(/^\/api\//, "")
	const method = req.method || "GET"
	const local = isLocalAddress(req.socket.remoteAddress)

	// CORS preflight: only this app's own origins may proceed.
	if (method === "OPTIONS") {
		const origin = requestOrigin(req)
		if (origin && !allowedOrigins().has(origin)) {
			res.writeHead(403, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "null", "content-length": Buffer.byteLength(JSON.stringify({ error: "Origin not allowed." })) })
			return res.end(JSON.stringify({ error: "Origin not allowed." }))
		}
		const headers = {
			"access-control-allow-methods": "GET, POST, OPTIONS",
			"access-control-allow-headers": "content-type, x-slc-token",
			"access-control-max-age": "600"
		}
		if (origin) {
			headers["access-control-allow-origin"] = origin
			headers["vary"] = "Origin"
		}
		res.writeHead(204, headers)
		return res.end()
	}

	// Reject cross-origin POSTs so another browser tab / foreign origin cannot change the screen.
	if (method === "POST" && !originAllowed(req)) {
		res.writeHead(403, {
			"content-type": "application/json; charset=utf-8",
			"access-control-allow-origin": "null",
			"content-length": Buffer.byteLength(JSON.stringify({ error: "Origin not allowed." }))
		})
		return res.end(JSON.stringify({ error: "Origin not allowed." }))
	}

	// /api/pair is the one route a phone must reach before it holds a token.
	if (route !== "pair" && !authorized(req, url)) return sendJson(res, 401, { error: "Phone not paired. Enter the PIN shown on the PC." })

	if (method === "POST" && state.locked && !local && ["show"].includes(route))
		return sendJson(res, 423, { error: "Output is locked by the PC." })
	if (method === "POST" && !local && ["prepare-show", "refresh", "config", "bind", "unbind", "output", "restore", "slide"].includes(route))
		return sendJson(res, 403, { error: "Only the PC can do that." })

	if (method === "GET" && route === "state") return sendJson(res, 200, publicState({ includePin: local }))
	if (method === "GET" && route === "songs") {
		refreshSongs()
		return sendJson(res, 200, { songs: songs.map((song) => ({ id: song.id, name: song.name, verseCount: song.verses.length })), error: songsError })
	}
	if (method === "GET" && route.startsWith("songs/")) {
		const song = getSong(config.showsDir, decodeURIComponent(route.slice(6)))
		if (!song) return sendJson(res, 404, { error: "Song not found" })
		return sendJson(res, 200, song)
	}
	if (method === "GET" && route === "health") return sendJson(res, 200, await checkHealth())

	if (method === "POST" && route === "pair") {
		const body = await readBody(req)
		const pin = String(body.pin || "").trim()
		if (!pin || pin !== String(config.pin)) return sendJson(res, 401, { error: "Wrong PIN." })
		const token = crypto.randomBytes(16).toString("hex")
		config.tokens = [...(Array.isArray(config.tokens) ? config.tokens : []), token].slice(-8)
		saveConfig(config)
		return sendJson(res, 200, { token })
	}

	if (method === "POST" && route === "select") {
		const body = await readBody(req)
		// `send: false` selects a verse (loading a song) without touching the projector.
		const result = await selectVerse(body, { canDisplay: body.send !== false && !(state.locked && !local) })
		return sendJson(res, 200, result)
	}

	if (method === "GET" && route === "output") {
		await refreshOutputWindows({ maxAge: 0 })
		return sendJson(res, 200, state.output)
	}

	if (method === "POST" && route === "output") {
		const body = await readBody(req)
		const want = String(body.action || "toggle")
		const before = await refreshOutputWindows({ maxAge: 0 })
		const visible = !!before.visible
		const change = want === "toggle" ? true : want === "start" ? !visible : visible
		if (!change) return sendJson(res, 200, { ...state.output, changed: false })
		try {
			await freeshow.toggleOutputWindows()
		} catch (err) {
			return sendJson(res, 502, { error: err?.message || String(err) })
		}
		await sleep(700)
		await refreshOutputWindows({ maxAge: 0 })
		broadcast()
		return sendJson(res, 200, { ...state.output, changed: true })
	}

	if (method === "POST" && route === "restore") {
		try {
			const live = await freeshow.restoreOutput()
			if (live?.text) setLive({ reference: inferReference(live.text), text: live.text, translation: state.translation, verified: true, at: Date.now() })
		} catch (err) {
			return sendJson(res, 502, { error: err?.message || String(err) })
		}
		broadcast()
		return sendJson(res, 200, { ok: true, live: state.live })
	}

	if (method === "POST" && route === "slide") {
		const body = await readBody(req)
		const direction = body.direction === "previous" ? "previous" : "next"
		const live = await freeshow.live()
		if (!live?.ok) return sendJson(res, 502, { error: "FreeShow is not reachable." })
		if (!freeshow.scratchId || live.showId !== freeshow.scratchId) {
			return sendJson(res, 409, { error: "Your scripture is not on screen — send a verse first." })
		}
		try {
			const after = await freeshow.advance(direction)
			return sendJson(res, 200, { ok: true, slideIndex: after?.slideIndex ?? null, text: after?.text || "" })
		} catch (err) {
			return sendJson(res, 502, { error: err?.message || String(err) })
		}
	}

	if (method === "POST" && route === "bind") {
		const body = await readBody(req)
		const songId = String(body.songId || state.current?.songId || "")
		const verseIndex = Number(body.verseIndex ?? state.current?.verseIndex)
		const reference = String(body.reference || state.live?.reference || "").trim()
		if (!songId || !Number.isInteger(verseIndex)) return sendJson(res, 400, { error: "Pick a song verse first." })
		const song = getSong(config.showsDir, songId)
		if (!song?.verses?.some((v) => v.index === verseIndex)) return sendJson(res, 400, { error: "Pick a song verse first." })
		if (!reference) return sendJson(res, 400, { error: "Choose a scripture first." })
		const resolved = lookup(state.translation, reference)
		if (!resolved?.ok) return sendJson(res, 400, { error: resolved?.error || `Could not read ${reference}` })
		// Only the reference is stored; the passage is re-resolved from the Bible data,
		// so pins follow a translation change instead of keeping stale text.
		bindings[bindingKey(songId, verseIndex)] = { reference: resolved.reference, translation: state.translation, at: Date.now() }
		saveBindings()
		refreshSuggestions()
		broadcast()
		let sent = null
		if (!(state.locked && !local)) {
			try {
				const result = await showReference(resolved.reference)
				sent = { reference: result.reference, verified: !!result.verified }
			} catch (err) {
				sent = { error: err?.message || String(err) }
			}
		}
		return sendJson(res, 200, { ok: true, binding: bindings[bindingKey(songId, verseIndex)], sent, suggestions: state.suggestions })
	}

	if (method === "POST" && route === "unbind") {
		const body = await readBody(req)
		const songId = String(body.songId || state.current?.songId || "")
		const verseIndex = Number(body.verseIndex ?? state.current?.verseIndex)
		const key = bindingKey(songId, verseIndex)
		const removed = !!bindings[key]
		delete bindings[key]
		saveBindings()
		refreshSuggestions()
		broadcast()
		return sendJson(res, 200, { ok: true, removed, suggestions: state.suggestions })
	}

	if (method === "POST" && route === "show") {
		const body = await readBody(req)
		if (!body.reference && !body.text) return sendJson(res, 400, { error: "Missing reference" })
		const reference = body.reference || body.text
		return sendJson(res, 200, await showReference(reference))
	}

	if (method === "POST" && route === "clear") return sendJson(res, 200, await clearScreen())

	if (method === "POST" && route === "manual") {
		const body = await readBody(req)
		return sendJson(res, 200, await setManual(body.reference))
	}

	if (method === "POST" && route === "lock") {
		const body = await readBody(req)
		state.locked = !!body.locked
		config.locked = state.locked
		saveConfig(config)
		saveSession()
		broadcast()
		return sendJson(res, 200, { locked: state.locked })
	}

	if (method === "POST" && route === "translation") {
		const body = await readBody(req)
		const id = String(body.translation || "").toUpperCase()
		const available = availableTranslations()
		if (!available[id]?.available) return sendJson(res, 400, { error: `${id} is not installed. ${available[id]?.note || ""}`.trim() })
		state.translation = id
		config.translation = id
		saveConfig(config)
		refreshSuggestions()
		saveSession()
		broadcast()
		return sendJson(res, 200, { translation: state.translation, suggestions: state.suggestions })
	}

	if (method === "POST" && route === "refresh") {
		const result = refreshSongs()
		refreshSuggestions()
		broadcast()
		return sendJson(res, 200, { songs: songs.length, error: result.error })
	}

	if (method === "POST" && route === "prepare-show") {
		try {
			const showId = await freeshow.resolveScratch()
			const live = await freeshow.live()
			return sendJson(res, 200, { showId, created: !!freeshow.created, live })
		} catch (err) {
			return sendJson(res, 502, { error: err?.message || String(err) })
		}
	}

	return sendJson(res, 404, { error: `Unknown API route "${route}"` })
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
	try {
		if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url)
		// serve static files to the local machine only
		if (!isLocalAddress(req.socket.remoteAddress)) {
			res.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
			return res.end("Forbidden")
		}
		return serveStatic(req, res, url)
	} catch (err) {
		const status = err?.status || 500
		if (status >= 500) console.error(`${req.method} ${url.pathname} ->`, err?.message || err)
		if (!res.headersSent) sendJson(res, status, { error: err?.message || "Server error" })
	}
})

// ---------------------------------------------------------------- websocket

const wss = new WebSocketServer({ server, path: "/ws" })

wss.on("connection", (socket, req) => {
	const url = new URL(req.url || "/", "http://localhost")
	const local = isLocalAddress(req.socket.remoteAddress)
	const token = url.searchParams.get("token") || ""
	const paired = local || (!!token && Array.isArray(config.tokens) && config.tokens.includes(token))

	if (!paired) {
		socket.close(4001, "pairing required")
		return
	}

	socket.authorizedSocket = true
	socket.isLocal = local
	socket.send(JSON.stringify({ type: "state", state: publicState({ includePin: local }) }))
	broadcast()

	socket.on("close", () => broadcast())
	socket.on("error", () => {})
})

// ---------------------------------------------------------------- boot

// Read what FreeShow is actually showing, instead of trusting the session file.
try {
	await restoreFromFreeShow()
} catch {
	state.live = null
}

refreshSongs()
if (state.current) {
	state.suggestionsFor = state.suggestionsFor || `${state.current.songName} · ${state.current.group || "Verse"}`
	refreshSuggestions()
} else if (state.manual) {
	state.suggestionsFor = state.suggestionsFor || state.manual.reference
	refreshSuggestions()
}

try { await checkHealth() } catch { /* leave health stale; don't crash at boot */ }

server.on("error", (err) => {
	if (err.code === "EADDRINUSE") console.error(`Port ${config.appPort} is already in use — is another copy of Live Scripture Control running?`)
	else console.error("Server error:", err.message)
	process.exit(1)
})

server.listen(config.appPort, config.appHost, async () => {
	console.log("")
	console.log("  LIVE SCRIPTURE CONTROL")
	console.log(`  PC view     http://localhost:${config.appPort}`)
	for (const url of lanUrls()) console.log(`  Phone view  ${url}/phone`)
	console.log(`  Phone PIN   ${config.pin}`)
	console.log(`  FreeShow    ${config.freeshow.host}:${config.freeshow.restPort} (REST) / ${config.freeshow.httpPort} (HTTP)`)
	console.log(`  Songs       ${songs.length} from ${config.showsDir}${songsError ? ` — ${songsError}` : ""}`)
	health = await freeshow.health()
	console.log(`  FreeShow    ${health.ok ? `connected via ${health.transport}` : `NOT reachable — ${health.error}`}`)
	console.log("")
	broadcast()
})

setInterval(() => checkHealth({ silent: false }).catch(() => {}), 15_000)

process.on("SIGINT", () => {
	saveConfig(config)
	writeJson(SESSION_FILE, { current: state.current, manual: state.manual, live: state.live, translation: state.translation, locked: state.locked })
	process.exit(0)
})
