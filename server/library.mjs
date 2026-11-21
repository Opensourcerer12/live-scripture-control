import fs from "node:fs"
import path from "node:path"

/**
 * Read-only view of the FreeShow song library.
 *
 * Measured format of Documents/FreeShow/Shows/<Name>.show:
 *   [ "<showId>", { name, category, settings: { activeLayout, template }, slides: { id: slide }, layouts: { id: { slides: [{ id }] } } } ]
 *
 * A slide's items are text boxes; the first text box holds the lyric,
 * later boxes hold things like the scripture reference. We read the song files directly
 * so the app works even when FreeShow is closed, and never writes to them.
 */

const cache = new Map()

function slideText(slide) {
	const items = Array.isArray(slide?.items) ? slide.items : []
	const item = items.find((it) => Array.isArray(it?.lines) && it.lines.some((l) => Array.isArray(l?.text) && l.text.length))
	if (!item) return ""
	return item.lines
		.map((line) => (line.text || []).map((part) => part.value || "").join(""))
		.join("\n")
		.replace(/[ \t]+\n/g, "\n")
		.trim()
}

function readSongFile(file) {
	let stat
	try {
		stat = fs.statSync(file)
	} catch {
		return null
	}
	const hit = cache.get(file)
	if (hit && hit.mtime === stat.mtimeMs) return hit.song

	let raw
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"))
	} catch {
		return null
	}

	let id = path.basename(file, ".show")
	let show = raw
	if (Array.isArray(raw)) {
		id = String(raw[0] ?? id)
		show = raw.find((part) => part && typeof part === "object" && (part.slides || part.layouts)) || raw[1]
	}
	if (!show || typeof show !== "object") return null

	const layout = show.layouts?.[show.settings?.activeLayout] || Object.values(show.layouts || {})[0] || null
	const slideIds = Array.isArray(layout?.slides) ? layout.slides.map((s) => s?.id).filter(Boolean) : Object.keys(show.slides || {})

	const verses = []
	slideIds.forEach((slideId, index) => {
		const slide = show.slides?.[slideId]
		const text = slideText(slide)
		if (!text) return
		verses.push({ index, slideId, group: slide?.group || "", text })
	})

	const song = {
		id,
		name: String(show.name || path.basename(file, ".show")),
		category: show.category || "",
		layoutId: show.settings?.activeLayout || Object.keys(show.layouts || {})[0] || "",
		verses
	}

	cache.set(file, { mtime: stat.mtimeMs, song })
	return song
}

export function listSongs(showsDir) {
	let files = []
	try {
		files = fs.readdirSync(showsDir).filter((name) => name.toLowerCase().endsWith(".show"))
	} catch (err) {
		return { songs: [], error: `Cannot read ${showsDir} (${err.code || err.message})` }
	}

	const songs = []
	for (const name of files) {
		const song = readSongFile(path.join(showsDir, name))
		if (song && song.verses.length) songs.push(song)
	}
	songs.sort((a, b) => a.name.localeCompare(b.name))
	return { songs, error: null }
}

export function getSong(showsDir, id) {
	const { songs } = listSongs(showsDir)
	return songs.find((song) => song.id === id) || null
}
