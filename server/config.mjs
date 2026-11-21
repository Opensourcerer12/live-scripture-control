import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// The packaged desktop app cannot write inside its install folder, so it points the
// writable side (config.json, session, pins, cache) at the user's app-data folder with
// LSC_STATE_DIR and keeps the shipped files (public/, the KJV, scripts/) where they are.
// Running from a terminal without that variable keeps everything in the project folder.
export const STATE_DIR = process.env.LSC_STATE_DIR ? path.resolve(process.env.LSC_STATE_DIR) : ROOT
export const PUBLIC_DIR = path.join(ROOT, "public")
export const DATA_DIR = path.join(STATE_DIR, "data")
const CONFIG_PATH = path.join(STATE_DIR, "config.json")

const SEED_DATA = ["kjv.json", "suggestions-cache.json", "verse-bindings.json"]

// First run of a packaged app: copy the bundled Bible, cache and pins into the writable
// folder. Existing files are never overwritten, so upgrades keep the user's data.
function seedStateDir() {
	if (STATE_DIR === ROOT) return
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true })
		for (const name of SEED_DATA) {
			const from = path.join(ROOT, "data", name)
			const to = path.join(DATA_DIR, name)
			if (!fs.existsSync(to) && fs.existsSync(from)) fs.copyFileSync(from, to)
		}
	} catch (err) {
		console.error(`Could not prepare ${DATA_DIR}:`, err.message)
	}
}

seedStateDir()

export function defaults() {
	return {
		appPort: 8099,
		appHost: "0.0.0.0",
		freeshow: {
			host: "127.0.0.1",
			httpPort: 5505,
			restPort: 5506,
			showName: "Live Scripture"
		},
		showsDir: path.join(os.homedir(), "Documents", "FreeShow", "Shows"),
		translation: "KJV",
		locked: false,
		pin: String(crypto.randomInt(1000, 10000)),
		tokens: []
	}
}

function merge(base, patch) {
	const out = { ...base }
	for (const [k, v] of Object.entries(patch || {})) {
		if (v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object" && base[k] !== null) out[k] = merge(base[k], v)
		else out[k] = v
	}
	return out
}

let cached = null

export function loadConfig() {
	if (cached) return cached
	let file = {}
	try {
		file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
	} catch (err) {
		if (err.code !== "ENOENT") console.error(`${CONFIG_PATH} could not be read (${err.message}) — using defaults`)
		file = {}
	}
	cached = merge(defaults(), file)
	// A config.json copied from another PC can point at a folder that does not exist here.
	// Use this user's own FreeShow library instead of showing an empty song list.
	if (!isDir(cached.showsDir)) {
		const fallback = path.join(os.homedir(), "Documents", "FreeShow", "Shows")
		if (isDir(fallback)) {
			console.warn(`showsDir ${cached.showsDir} not found — using ${fallback}`)
			cached.showsDir = fallback
		}
	}
	if (!fs.existsSync(CONFIG_PATH)) saveConfig(cached)
	return cached
}

function isDir(target) {
	try {
		return fs.statSync(target).isDirectory()
	} catch {
		return false
	}
}

export function saveConfig(cfg = cached) {
	if (!cfg) return
	cached = cfg
	try {
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
	} catch (err) {
		console.error("Could not save config.json:", err.message)
	}
}

/**
 * This machine's IPv4 addresses, the one most likely to work on the church Wi-Fi first.
 * VPN adapters (Tailscale's 100.64/10) and link-local addresses sort last, so the URL the
 * app prints for phones is not a address the phone cannot reach.
 */
export function lanAddresses() {
	const found = []
	for (const entries of Object.values(os.networkInterfaces())) {
		for (const net of entries || []) {
			if (net.family === "IPv4" && !net.internal) found.push(net.address)
		}
	}
	return found.sort((a, b) => addressRank(a) - addressRank(b))
}

function addressRank(address) {
	const [first, second] = String(address).split(".").map(Number)
	if (first === 192 && second === 168) return 0
	if (first === 10) return 1
	if (first === 172 && second >= 16 && second <= 31) return 2
	if (first === 100 && second >= 64 && second <= 127) return 8
	if (first === 169 && second === 254) return 9
	return 5
}

export function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"))
	} catch {
		return fallback
	}
}

export function writeJson(file, value) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, JSON.stringify(value, null, 2))
	} catch (err) {
		console.error(`Could not write ${file}:`, err.message)
	}
}
