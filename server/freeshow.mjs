/**
 * FreeShow adapter.
 *
 * Everything here is based on measured behaviour (see docs/FREESHOW-API-FINDINGS.md):
 *
 *  - REST  : POST JSON { action, ...data } to port 5506 -> 204, or a JSON reply for get_* actions.
 *  - HTTP  : GET ?action=X&data={json} on port 5505 -> same dispatcher (works, slower).
 *  - Reply  : every get_* answer is wrapped as { action, data } and must be unwrapped.
 *  - Live   : `set_plain_text {id, value}` rewrites a show; `start_show {id}` puts it on
 *             screen. If that show is already live, the text changes with no re-transition.
 *  - `index_select_project_item` only highlights a row in the project list; it never
 *             reaches output, which is why it looked like a no-op.
 *  - `create_show` appends the new show to the currently open project. We therefore only
 *             create it once, and the UI tells the operator to delete that extra row if
 *             they do not want it in the service project. We never splice project rows:
 *             measured `remove_project_item` splices by internal array index, which does
 *             not match `get_projects` order and can delete the wrong item.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function unwrap(text) {
	if (!text) return null
	let parsed
	try {
		parsed = JSON.parse(text)
	} catch {
		return text
	}
	if (parsed && typeof parsed === "object" && "action" in parsed && "data" in parsed) return parsed.data
	return parsed
}

/** Break long passages into slide-sized paragraphs. FreeShow starts a new slide at each blank line. */
export function formatForFreeShow({ reference, text, translation = "KJV", maxChars = 320 }) {
	const label = `— ${reference}${translation ? ` (${translation})` : ""}`
	const clean = String(text || "").replace(/\s+/g, " ").trim()
	if (!clean) return label

	const sentences = clean.match(/[^.!?]+[.!?]*\s*/g) || [clean]
	const chunks = []
	let current = ""
	for (const sentence of sentences) {
		if (current && (current + sentence).length > maxChars) {
			chunks.push(current.trim())
			current = sentence
		} else current += sentence
	}
	if (current.trim()) chunks.push(current.trim())
	if (!chunks.length) chunks.push(clean)

	return [...chunks, label].join("\n\n")
}

export class FreeShow {
	constructor(getConfig) {
		this.getConfig = getConfig
		this.scratchId = null
		this.lastTransport = null
	}

	get cfg() {
		return this.getConfig().freeshow
	}

	/**
	 * Send one action, trying REST first (verified, fastest) then the HTTP query route.
	 * Returns { ok, transport, status, data } or throws with every transport's error.
	 */
	async request(payload, { timeout = 4000 } = {}) {
		const cfg = this.cfg
		const errors = []

		try {
			const res = await fetch(`http://${cfg.host}:${cfg.restPort}/`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(timeout)
			})
			this.lastTransport = `REST ${cfg.restPort}`
			return { ok: true, transport: this.lastTransport, status: res.status, data: unwrap(await res.text()) }
		} catch (err) {
			errors.push(`REST ${cfg.restPort}: ${err?.message || err}`)
		}

		try {
			const { action, ...rest } = payload
			const url = new URL(`http://${cfg.host}:${cfg.httpPort}/`)
			url.searchParams.set("action", action)
			url.searchParams.set("data", JSON.stringify(rest))
			const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeout) })
			this.lastTransport = `HTTP ${cfg.httpPort}`
			return { ok: true, transport: this.lastTransport, status: res.status, data: unwrap(await res.text()) }
		} catch (err) {
			errors.push(`HTTP ${cfg.httpPort}: ${err?.message || err}`)
		}

		throw new Error(`FreeShow unreachable (${errors.join(" | ")})`)
	}

	/** What is actually on screen right now, straight from FreeShow. */
	async live() {
		try {
			const text = await this.request({ action: "get_output_slide_text" }, { timeout: 3000 })
			let slide = null
			try {
				const out = await this.request({ action: "get_output" }, { timeout: 3000 })
				slide = out?.data?.slide || null
			} catch {
				slide = null
			}
			return {
				ok: true,
				text: (typeof text.data === "string" ? text.data : "").trim(),
				showId: slide?.id || null,
				layoutId: slide?.layout || null,
				slideIndex: slide?.index ?? null,
				transport: text.transport
			}
		} catch (err) {
			return { ok: false, text: "", showId: null, layoutId: null, slideIndex: null, error: err?.message || String(err) }
		}
	}

	/** Find our dedicated show, creating it once if the library does not have it yet. */
	async resolveScratch({ force = false } = {}) {
		const name = this.cfg.showName || "Live Scripture"
		if (this.scratchId && !force) return this.scratchId

		const find = async () => {
			const res = await this.request({ action: "get_shows" })
			const map = res.data && typeof res.data === "object" ? res.data : {}
			const id = Object.keys(map).find((k) => String(map[k]?.name || "").trim().toLowerCase() === name.toLowerCase())
			return id || null
		}

		let id = await find()
		if (!id) {
			// create_show needs a body; a single space becomes an empty show we immediately overwrite.
			await this.request({ action: "create_show", name, text: " " })
			await sleep(350)
			id = await find()
		}
		if (!id) throw new Error(`Could not create or find the "${name}" show in FreeShow`)

		this.created = !this.scratchId
		this.scratchId = id
		return id
	}

	/** Split a passage into slide-sized chunks at sentence boundaries. */
	static chunkText(text, max = 300) {
		const clean = String(text || "").replace(/\s+/g, " ").trim()
		if (!clean) return [""]
		const sentences = clean.match(/[^.!?]+[.!?]*\s*/g) || [clean]
		const chunks = []
		let current = ""
		for (const sentence of sentences) {
			if (current && (current + sentence).length > max) {
				chunks.push(current.trim())
				current = sentence
			} else current += sentence
		}
		if (current.trim()) chunks.push(current.trim())
		return chunks.length ? chunks : [clean]
	}

	/** How many rendered lines a paragraph needs at a given font size. */
	static wrapCount(text, width, fontSize) {
		const perLine = Math.max(4, Math.floor(width / (fontSize * 0.66)))
		const words = String(text || "").split(/\s+/).filter(Boolean)
		if (!words.length) return 1
		let lines = 1
		let current = 0
		for (const word of words) {
			const add = current ? word.length + 1 : word.length
			if (current + add > perLine) {
				lines += 1
				current = word.length
			} else current += add
		}
		return lines
	}

	/**
	 * FreeShow renders the stored auto size, so the size must be computed for the
	 * box before the slide is written (a raw `font-size:800px` overflows and the
	 * projector clips it). Largest size where the wrapped text still fits.
	 */
	static fitFontSize(paragraphs, { width, height, reference = "", max = 84, min = 20 }) {
		const lines = paragraphs.length ? paragraphs : [""]
		for (let size = max; size >= min; size -= 1) {
			let count = 0
			for (const line of lines) count += FreeShow.wrapCount(line, width, size)
			if (reference) count += FreeShow.wrapCount(reference, width, size * 0.7)
			// FreeShow's rendered line box is ~1.95x the font size, so budget for that.
			if (count * size * 1.95 <= height * 0.98) return size
		}
		return min
	}

	/**
	 * Build the "Live Scripture" show: the current song's lyric on the left and
	 * the chosen passage on the right, so both are on screen at the same time —
	 * matching the user's song layout. The lyric item is cloned from the song's
	 * own slide so its styling matches; sizes are computed per box so nothing is
	 * clipped on the projector.
	 */
	buildShowValue(current, songShow, verseIndex, { reference, text, translation }) {
		const leftSlot = "top:176.00px;left:50.00px;height:904.00px;width:910.00px;"
		const rightSlot = "top:176.00px;left:960.00px;height:904.00px;width:930.00px;"
		const leftBox = { width: 910, height: 904 }
		const rightBox = { width: 930, height: 904 }
		const clone = (obj) => JSON.parse(JSON.stringify(obj))

		let songSlide = null
		if (songShow) {
			const layouts = songShow.layouts || {}
			const layout = layouts[songShow.settings?.activeLayout] || Object.values(layouts)[0]
			const ref = layout?.slides?.[verseIndex] || layout?.slides?.[0]
			songSlide = ref ? songShow.slides?.[ref.id] : null
		}

		// Lyric: keep the song's own line breaks, but size them for the left box.
		const lyricItem = songSlide?.items?.[0] ? clone(songSlide.items[0]) : { type: "text", lines: [] }
		const lyricLines = (lyricItem.lines || [])
			.map((line) => (line.text || []).map((part) => part.value).join(""))
			.filter((line) => line.trim())
		const lyricSize = FreeShow.fitFontSize(lyricLines, { ...leftBox, max: 80 })
		lyricItem.style = leftSlot
		lyricItem.type = lyricItem.type || "text"
		// shrinkToFit keeps the computed size and only shrinks when needed;
		// growToFit would blow short text up to fill the whole box.
		lyricItem.textFit = "shrinkToFit"
		lyricItem.autoFontSize = lyricSize
		if (lyricLines.length) lyricItem.lines = lyricLines.map((value) => ({ align: "", text: [{ value, style: `font-size:${lyricSize}px;` }] }))

		let rightBase = songSlide?.items?.[1] ? clone(songSlide.items[1]) : { type: "text", lines: [] }
		rightBase.style = rightSlot
		rightBase.type = rightBase.type || "text"
		rightBase.textFit = "shrinkToFit"

		const label = `- ${reference}${translation ? ` (${translation})` : ""}`
		const chunks = FreeShow.chunkText(text)
		const slides = {}
		const layoutSlides = []
		const stamp = Date.now().toString(36)

		chunks.forEach((chunk, i) => {
			const last = i === chunks.length - 1
			const sid = `ls${stamp}${i}${Math.random().toString(36).slice(2, 6)}`
			const size = FreeShow.fitFontSize([chunk], { ...rightBox, reference: last ? label : "", max: 80 })
			const items = [clone(lyricItem)]
			const right = clone(rightBase)
			right.autoFontSize = size
			const lines = [{ align: "", text: [{ value: chunk, style: `font-size:${size}px;` }] }]
			if (last) lines.push({ align: "", text: [{ value: label, style: `font-size:${Math.round(size * 0.7)}px;` }] })
			right.lines = lines
			items.push(right)
			slides[sid] = { group: "Verse", color: "", settings: {}, notes: "", items }
			layoutSlides.push({ id: sid, children: {} })
		})

		// A second identical slide gives the repaint step a slide to step to and back
		// (FreeShow only re-renders the live slide when its index changes).
		if (layoutSlides.length === 1) {
			const twinId = `ls${stamp}twin`
			slides[twinId] = clone(slides[layoutSlides[0].id])
			layoutSlides.push({ id: twinId, children: {} })
		}

		const layoutId = Object.keys(current.layouts || {})[0] || "layout"
		return {
			...current,
			settings: { ...(current.settings || {}), activeLayout: layoutId, template: "default" },
			slides,
			layouts: { [layoutId]: { name: "Default", notes: "", slides: layoutSlides } }
		}
	}

	/** Poll until the expected text is on screen. */
	async waitForText(expected, { tries = 6, delay = 200 } = {}) {
		const probe = String(expected || "").replace(/\s+/g, " ").trim().slice(0, 40)
		let live = await this.live()
		for (let i = 0; i < tries; i++) {
			const seen = String(live.text || "").replace(/\s+/g, " ").trim()
			if (seen && (!probe || seen.includes(probe))) return { ...live, verified: true }
			await sleep(delay)
			live = await this.live()
		}
		return { ...live, verified: false }
	}

	/**
	 * Put a verse on screen. Builds a combined slide (song lyric left, scripture
	 * right) and writes it through FreeShow's own `set_show` action, which updates
	 * the show in memory and re-renders the live output — so tapping a different
	 * suggestion updates the screen while the lyric stays put.
	 */
	async display({ reference, text, translation = "KJV", songId = null, verseIndex = 0 }) {
		const id = await this.resolveScratch()
		const current = (await this.request({ action: "get_show", id }))?.data || {}

		let songShow = null
		if (songId) {
			try { songShow = (await this.request({ action: "get_show", id: songId }))?.data || null } catch { songShow = null }
		}

		const value = this.buildShowValue(current, songShow, verseIndex, { reference, text, translation })
		const before = await this.live()
		await this.request({ action: "set_show", id, value: JSON.stringify(value) })

		if (before.showId !== id) await this.request({ action: "start_show", id })
		await this.repaint(id)

		let live = await this.waitForText(text)
		if (live.verified) {
			return { ok: true, verified: true, path: "set_show+repaint", showId: id, live, transport: this.lastTransport }
		}

		// Fallback: force a fresh start and repaint, then verify again.
		await this.request({ action: "start_show", id })
		await this.repaint(id)
		live = await this.waitForText(text)
		return {
			ok: live.verified,
			verified: live.verified,
			path: "set_show+start_show+repaint",
			showId: id,
			live,
			transport: this.lastTransport,
			note: live.verified ? undefined : "FreeShow accepted the calls but the output text did not update"
		}
	}

	/**
	 * `set_show` replaces the show data but FreeShow keeps painting the slide it
	 * already resolved, so the projector sits on the old frame. Moving to the
	 * next slide and back makes it rebuild the live slide from the new data.
	 * Only done when our own show is the one live, so a service song is never advanced.
	 */
	async repaint(id) {
		const live = await this.live()
		if (live.showId !== id) return false
		await this.request({ action: "next_slide" })
		await sleep(150)
		await this.request({ action: "previous_slide" })
		await sleep(150)
		return true
	}

	/** Step within the live show (long passages are split across slides). */
	async advance(direction = "next") {
		await this.request({ action: direction === "previous" ? "previous_slide" : "next_slide" })
		await sleep(150)
		return this.live()
	}

	/** Put back the slide layers that `clear_all` removed. */
	async restoreOutput() {
		await this.request({ action: "restore_output" })
		await sleep(200)
		return this.live()
	}

	/** FreeShow's Present button: show/hide the live output window(s). */
	async toggleOutputWindows() {
		await this.request({ action: "toggle_output_windows" })
		return true
	}

	/** Blank the output. */
	async clear() {
		await this.request({ action: "clear_all" })
		const live = await this.waitForText("", { tries: 3, delay: 150 })
		return { ok: true, verified: !live.text, live, transport: this.lastTransport }
	}

	/** Connectivity + capability report, used by the status line and /api/health. */
	async health() {
		const cfg = this.cfg
		try {
			const started = Date.now()
			const res = await this.request({ action: "get_shows" }, { timeout: 2500 })
			const shows = res.data && typeof res.data === "object" ? Object.keys(res.data).length : 0
			return {
				ok: true,
				transport: res.transport,
				latency: Date.now() - started,
				shows,
				host: cfg.host,
				httpPort: cfg.httpPort,
				restPort: cfg.restPort
			}
		} catch (err) {
			return {
				ok: false,
				error: err?.message || String(err),
				host: cfg.host,
				httpPort: cfg.httpPort,
				restPort: cfg.restPort
			}
		}
	}
}
