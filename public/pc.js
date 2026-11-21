const $ = (id) => document.getElementById(id)

let state = null
let songDetail = null
let toastTimer = null

async function api(path, { body } = {}) {
	const res = await fetch(`/api/${path}`, {
		method: body ? "POST" : "GET",
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined
	})
	let data = {}
	try {
		data = await res.json()
	} catch {
		data = {}
	}
	if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
	return data
}

function toast(message, isError = false) {
	const el = $("toast")
	el.textContent = message
	el.classList.toggle("error", isError)
	el.classList.add("show")
	clearTimeout(toastTimer)
	toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 5200 : 2600)
}

const preview = (text, max = 150) => {
	const clean = String(text || "").replace(/\s+/g, " ").trim()
	return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

// ---------------------------------------------------------------- render

function renderTranslations() {
	const select = $("translation")
	const available = state?.translations || {}
	const options = Object.values(available)
	select.innerHTML = ""
	for (const t of options) {
		const opt = document.createElement("option")
		opt.value = t.id
		opt.textContent = t.available ? t.id : `${t.id} (not installed)`
		opt.disabled = !t.available
		select.appendChild(opt)
	}
	select.value = state?.translation || "KJV"
}

function renderLive() {
	const live = state?.live
	if (!live) {
		$("liveRef").textContent = "Nothing"
		$("liveText").textContent = ""
		return
	}
	$("liveRef").textContent = live.reference ? `${live.reference}${live.translation ? ` · ${live.translation}` : ""}` : (live.text ? `Live scripture${live.translation ? ` · ${live.translation}` : ""}` : "Nothing")
	$("liveText").textContent = preview(live.text, 240)
	$("liveText").title = live.text || ""
}

function songButton(song, extraClass = "") {
	const button = document.createElement("button")
	button.type = "button"
	button.className = `song-btn ${extraClass}`.trim()
	if (state?.current?.songId === song.id) button.classList.add("active")
	const name = document.createElement("span")
	name.textContent = song.name
	const count = document.createElement("span")
	count.className = "n"
	count.textContent = String(song.verseCount)
	button.append(name, count)
	button.addEventListener("click", () => loadSong(song.id))
	return button
}

function renderSchedule() {
	const block = $("scheduleBlock")
	const list = $("scheduleList")
	const schedule = state?.schedule
	const items = schedule?.items || []

	if (!items.length) {
		block.hidden = true
		list.innerHTML = ""
		block.title = schedule?.error || ""
		return
	}

	block.hidden = false
	block.title = schedule.error ? `FreeShow project unreachable: ${schedule.error}` : "Songs in FreeShow's current project"
	$("schedName").textContent = schedule.project || ""

	list.innerHTML = ""
	for (const item of items) list.appendChild(songButton(item, "sched-btn"))
}

function renderSongs() {
	const query = ($("songSearch").value || "").trim().toLowerCase()
	const songs = (state?.songs || []).filter((song) => !query || song.name.toLowerCase().includes(query))
	const list = $("songList")
	list.innerHTML = ""

	$("songCount").textContent = `${songs.length}/${state?.songs?.length || 0}`

	if (!songs.length) {
		list.innerHTML = `<p class="empty">${state?.songsError ? state.songsError : "No songs found."}</p>`
		return
	}

	for (const song of songs) list.appendChild(songButton(song))
}

function renderVerses() {
	const list = $("verseList")
	list.innerHTML = ""
	$("songTitle").textContent = songDetail ? songDetail.name : "Verses"
	$("verseCount").textContent = songDetail ? `${songDetail.verses.length}` : ""

	if (!songDetail) {
		$("songHint").hidden = false
		return
	}
	$("songHint").hidden = true

	for (const verse of songDetail.verses) {
		const button = document.createElement("button")
		button.type = "button"
		button.className = "verse-btn"
		const isCurrent = state?.current?.songId === songDetail.id && state?.current?.verseIndex === verse.index
		if (isCurrent) button.classList.add("active")

		const text = document.createElement("span")
		text.className = "v-text"
		text.textContent = verse.text

		const meta = document.createElement("span")
		meta.className = "v-meta"
		meta.textContent = `${verse.group || "Verse"} · ${verse.index + 1}`
		const bound = state?.bindings?.[`${songDetail.id}::${verse.index}`]
		if (bound) {
			const pin = document.createElement("span")
			pin.className = "v-bound"
			pin.textContent = `📖 ${bound.reference}`
			meta.append(pin)
		}

		button.append(text, meta)
		button.addEventListener("click", () => selectVerse(songDetail.id, verse.index))
		list.appendChild(button)
	}
}

function renderSuggestions() {
	const list = $("suggestionList")
	list.innerHTML = ""

	const label = state?.suggestionsFor || state?.current?.label || ""
	$("suggFor").textContent = label ? preview(label, 40) : ""

	const suggestions = state?.suggestions || []
	if (!suggestions.length) {
		list.innerHTML = `<p class="empty">Select a verse or load a manual reference to see 3–5 suggestions.</p>`
		return
	}

	const canPin = !!state?.pinTarget

	suggestions.forEach((suggestion, index) => {
		const card = document.createElement("div")
		card.className = "sugg-card"
		card.setAttribute("role", "button")
		card.tabIndex = 0
		if (suggestion.bound) card.classList.add("bound")

		const top = document.createElement("span")
		top.className = "sugg-top"
		const ref = document.createElement("span")
		ref.className = "sugg-ref"
		ref.textContent = `${index + 1}. ${suggestion.reference}`
		const theme = document.createElement("span")
		theme.className = "sugg-theme"
		theme.textContent = suggestion.theme || ""
		top.append(ref, theme)

		const text = document.createElement("span")
		text.className = "sugg-text"
		text.textContent = preview(suggestion.text, 165)

		const actions = document.createElement("div")
		actions.className = "sugg-actions"
		const pin = document.createElement("button")
		pin.type = "button"
		pin.className = "pin-btn"
		pin.disabled = !canPin
		if (suggestion.bound) {
			pin.textContent = "Unpin from this verse"
			pin.classList.add("on")
		} else {
			pin.textContent = "Use for this verse"
		}
		pin.addEventListener("click", (event) => {
			event.stopPropagation()
			if (suggestion.bound) unpinVerse()
			else pinSuggestion(suggestion.reference)
		})
		actions.append(pin)

		card.append(top, text, actions)
		card.addEventListener("click", () => show(suggestion.reference))
		card.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault()
				show(suggestion.reference)
			}
		})
		list.appendChild(card)
	})
}

function renderStatus() {
	const fs = state?.freeshow || {}
	$("fsStatus").innerHTML = fs.ok
		? `<span class="ok">connected · ${fs.transport || ""}${typeof fs.latency === "number" ? ` · ${fs.latency}ms` : ""}</span>`
		: `<span class="bad">offline</span>`

	$("pinValue").textContent = state?.pin || "—"
	$("phoneCount").textContent = `${state?.clients ?? 0}`
	const urls = state?.urls?.lan || []
	$("phoneUrls").textContent = urls.length ? `${urls[0]}/phone` : `${location.origin}/phone`
	$("freeshowNote").hidden = !!fs.ok
	$("freeshowNote").textContent = fs.ok ? "" : (fs.error || "Start FreeShow and enable Connections → API.")

	renderOutput()

	const lockBtn = $("lockBtn")
	lockBtn.textContent = state?.locked ? "Unlock phones" : "Lock phones"
	lockBtn.classList.toggle("locked", !!state?.locked)
	lockBtn.title = state?.locked ? "Phones cannot change the screen" : "Prevent phones from changing the screen"

	$("manualShowBtn").disabled = !state?.manual
	$("manualMsg").textContent = state?.manual
		? `Loaded: ${state.manual.reference} — ${preview(state.manual.text, 90)}`
		: "Loads the passage and its suggestions without touching the screen."
}

function renderOutput() {
	const button = $("outputBtn")
	const status = $("outputStatus")
	const out = state?.output

	if (!out || out.ok === false) {
		button.textContent = "Output —"
		button.classList.remove("on")
		button.title = out?.error || "Whether the output window is open is unknown"
		status.innerHTML = `<span class="bad">unknown</span>`
		status.title = out?.error || ""
		return
	}

	button.textContent = out.visible ? "Stop output" : "Start output"
	button.classList.toggle("on", !!out.visible)
	button.title = out.visible ? "Hide FreeShow's live output window" : "Show FreeShow's live output window"
	status.innerHTML = out.visible ? `<span class="ok">on screen</span>` : `<span class="bad">hidden</span>`
	status.title = (out.windows || []).filter((win) => win.visible).map((win) => win.title).join(", ")
}

function render() {
	if (!state) return
	renderTranslations()
	renderLive()
	renderSchedule()
	renderSongs()
	renderVerses()
	renderSuggestions()
	renderStatus()
}

// ---------------------------------------------------------------- actions

async function loadSong(songId) {
	try {
		songDetail = await api(`songs/${encodeURIComponent(songId)}`)
		render()
		// Loading a song only sets the panel's context (verse 1); it must not touch the projector.
		if (state?.current?.songId !== songId) await api("select", { body: { songId, verseIndex: 0, send: false } })
	} catch (err) {
		toast(err.message, true)
	}
}

async function selectVerse(songId, verseIndex) {
	try {
		const result = await api("select", { body: { songId, verseIndex } })
		if (result.sent?.verified) toast(`On screen: ${result.sent.reference}`)
		else if (result.sent) toast(`Sent ${result.sent.reference}, but FreeShow did not confirm the output.`, true)
		else if (result.sendError) toast(result.sendError, true)
	} catch (err) {
		toast(err.message, true)
	}
}

async function pinSuggestion(reference) {
	const target = state?.pinTarget
	if (!target) return toast("Pick a song verse first.", true)
	try {
		const result = await api("bind", { body: { ...target, reference } })
		if (result.sent?.verified) toast(`${reference} pinned to this verse and on screen`)
		else toast(`${reference} pinned to this verse`)
	} catch (err) {
		toast(err.message, true)
	}
}

async function unpinVerse() {
	const target = state?.pinTarget
	if (!target) return
	try {
		await api("unbind", { body: target })
		toast("Pin removed for this verse")
	} catch (err) {
		toast(err.message, true)
	}
}

async function show(reference) {
	try {
		const result = await api("show", { body: { reference } })
		if (result.verification?.verified) toast(`On screen: ${result.live?.reference || reference}`)
		else toast(`Sent ${reference}, but FreeShow did not confirm the output.`, true)
	} catch (err) {
		toast(err.message, true)
	}
}

async function clearScreen() {
	try {
		await api("clear", { body: {} })
		toast("Screen cleared")
	} catch (err) {
		toast(err.message, true)
	}
}

async function toggleOutput() {
	try {
		const result = await api("output", { body: { action: "toggle" } })
		if (state) state.output = result
		renderOutput()
		if (result.ok === false) toast(result.error || "Could not read the output state.", true)
		else toast(result.visible ? "Output window is on" : "Output window is off")
	} catch (err) {
		toast(err.message, true)
	}
}

async function restoreScreen() {
	try {
		await api("restore", { body: {} })
		toast("Restored the last cleared slide")
	} catch (err) {
		toast(err.message, true)
	}
}

async function changeSlide(direction) {
	const button = direction === "previous" ? $("prevSlideBtn") : $("nextSlideBtn")
	button.disabled = true
	try {
		await api("slide", { body: { direction } })
	} catch (err) {
		toast(err.message, true)
	} finally {
		button.disabled = false
	}
}

let outputPending = false
async function refreshOutput() {
	if (outputPending) return
	outputPending = true
	try {
		const out = await api("output")
		if (!state) return
		state.output = out
		renderOutput()
	} catch { /* leave the last known state */ } finally {
		outputPending = false
	}
}

async function toggleLock() {
	try {
		await api("lock", { body: { locked: !state?.locked } })
	} catch (err) {
		toast(err.message, true)
	}
}

async function changeTranslation(value) {
	try {
		await api("translation", { body: { translation: value } })
	} catch (err) {
		toast(err.message, true)
		renderTranslations()
	}
}

async function loadManual(reference) {
	try {
		await api("manual", { body: { reference } })
		toast(`Loaded ${reference}`)
	} catch (err) {
		toast(err.message, true)
	}
}

// ---------------------------------------------------------------- wiring

$("songSearch").addEventListener("input", renderSongs)
$("manualForm").addEventListener("submit", (event) => {
	event.preventDefault()
	const reference = $("manualInput").value.trim()
	if (reference) loadManual(reference)
})
$("manualShowBtn").addEventListener("click", () => {
	if (state?.manual) show(state.manual.reference)
})
$("clearBtn").addEventListener("click", clearScreen)
$("lockBtn").addEventListener("click", toggleLock)
$("outputBtn").addEventListener("click", toggleOutput)
$("restoreBtn").addEventListener("click", restoreScreen)
$("prevSlideBtn").addEventListener("click", () => changeSlide("previous"))
$("nextSlideBtn").addEventListener("click", () => changeSlide("next"))
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) refreshOutput()
})
$("translation").addEventListener("change", (event) => changeTranslation(event.target.value))

function connect() {
	const protocol = location.protocol === "https:" ? "wss" : "ws"
	const socket = new WebSocket(`${protocol}://${location.host}/ws`)

	socket.addEventListener("message", (event) => {
		let message
		try {
			message = JSON.parse(event.data)
		} catch {
			return
		}
		if (message.type !== "state") return
		state = message.state
		// The server has no output state until someone asks for it (it needs a window check).
		if (!state.output) refreshOutput()
		const currentId = state.current?.songId
		if (currentId && songDetail?.id !== currentId) {
			api(`songs/${encodeURIComponent(currentId)}`)
				.then((song) => {
					songDetail = song
					render()
				})
				.catch(() => {})
		}
		render()
	})

	socket.addEventListener("close", () => setTimeout(connect, 1200))
}

async function boot() {
	try {
		state = await api("state")
		render()
		refreshOutput()
		const currentId = state.current?.songId
		if (currentId) {
			songDetail = await api(`songs/${encodeURIComponent(currentId)}`)
			render()
		}
	} catch (err) {
		toast(err.message, true)
	}
	connect()
}

boot()
