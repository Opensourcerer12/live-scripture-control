const $ = (id) => document.getElementById(id)

const TOKEN_KEY = "slc_token"
let token = localStorage.getItem(TOKEN_KEY) || ""
let state = null
let socket = null
let sheetMode = "songs"
let toastTimer = null

// phone requests always carry the token; pairing is the only call that creates one.
async function api(path, { body } = {}) {
	const res = await fetch(`/api/${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			...(body ? { "content-type": "application/json" } : {}),
			...(token ? { "x-slc-token": token } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	})
	let data = {}
	try {
		data = await res.json()
	} catch {
		data = {}
	}
	if (res.status === 401) {
		signOut()
		throw new Error(data.error || "Pairing expired. Enter the PIN again.")
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
	toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 5200 : 2400)
}

const preview = (text, max = 210) => {
	const clean = String(text || "").replace(/\s+/g, " ").trim()
	return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

function signOut() {
	token = ""
	localStorage.removeItem(TOKEN_KEY)
	if (socket) {
		socket.onclose = null
		socket.close()
		socket = null
	}
	$("app").hidden = true
	$("gate").hidden = false
	$("pinInput").value = ""
}

// ---------------------------------------------------------------- render

function render() {
	if (!state) return
	const live = state.live
	const card = $("liveCard")

	if (live) {
		card.classList.remove("blank")
		$("liveRef").textContent = live.reference ? `${live.reference}${live.translation ? ` · ${live.translation}` : ""}` : (live.text ? `Live scripture${live.translation ? ` · ${live.translation}` : ""}` : "Nothing on screen")
		$("liveText").textContent = live.text
	} else {
		card.classList.add("blank")
		$("liveRef").textContent = "Nothing on screen"
		$("liveText").textContent = ""
	}

	$("lockBadge").hidden = !state.locked
	$("contextLabel").textContent = state.suggestionsFor || state?.current?.label || ""

	const list = $("suggestionList")
	list.innerHTML = ""
	const suggestions = state.suggestions || []
	if (!suggestions.length) {
		list.innerHTML = `<p class="empty">Pick a song and verse to see suggestions.</p>`
	}

	suggestions.slice(0, 5).forEach((suggestion) => {
		const card = document.createElement("button")
		card.type = "button"
		card.className = "sugg-card"
		card.disabled = !!state.locked
		if (state.locked) card.style.opacity = 0.5

		const top = document.createElement("span")
		top.className = "sugg-top"
		const ref = document.createElement("span")
		ref.className = "sugg-ref"
		ref.textContent = suggestion.reference
		const theme = document.createElement("span")
		theme.className = "sugg-theme"
		theme.textContent = suggestion.theme || ""
		top.append(ref, theme)

		const text = document.createElement("span")
		text.className = "sugg-text"
		text.textContent = preview(suggestion.text)

		card.append(top, text)
		card.addEventListener("click", () => show(suggestion.reference))
		list.appendChild(card)
	})
}

// ---------------------------------------------------------------- actions

async function show(reference) {
	if (state?.locked) return toast("The PC locked the screen.", true)
	try {
		const result = await api("show", { body: { reference } })
		if (result.verification?.verified) toast(`On screen: ${result.live?.reference || reference}`)
		else toast(`Sent ${reference}, but FreeShow did not confirm it.`, true)
	} catch (err) {
		toast(err.message, true)
	}
}

$("clearBtn").addEventListener("click", async () => {
	try {
		await api("clear", { body: {} })
		toast("Screen cleared")
	} catch (err) {
		toast(err.message, true)
	}
})

// ---------------------------------------------------------------- picker

function openSheet() {
	sheetMode = "songs"
	$("sheetTitle").textContent = "Songs"
	$("sheetSearch").value = ""
	$("sheetSearch").hidden = false
	$("sheet").hidden = false
	renderSheetSongs()
}

function closeSheet() {
	$("sheet").hidden = true
}

function renderSheetSongs() {
	const query = ($("sheetSearch").value || "").trim().toLowerCase()
	const songs = (state?.songs || []).filter((song) => !query || song.name.toLowerCase().includes(query))
	const list = $("sheetList")
	list.innerHTML = ""

	for (const song of songs) {
		const button = document.createElement("button")
		button.type = "button"
		button.className = "song-btn"
		if (state?.current?.songId === song.id) button.classList.add("active")
		const name = document.createElement("span")
		name.textContent = song.name
		const count = document.createElement("span")
		count.className = "n"
		count.textContent = String(song.verseCount)
		button.append(name, count)
		button.addEventListener("click", () => renderSheetVerses(song))
		list.appendChild(button)
	}
	if (!songs.length) list.innerHTML = `<p class="empty">${state?.songsError || "No songs found."}</p>`
}

async function renderSheetVerses(song) {
	sheetMode = "verses"
	$("sheetTitle").textContent = song.name
	$("sheetSearch").hidden = true
	const list = $("sheetList")
	list.innerHTML = `<p class="empty">Loading verses…</p>`

	try {
		const detail = await api(`songs/${encodeURIComponent(song.id)}`)
		list.innerHTML = ""
		for (const verse of detail.verses) {
			const button = document.createElement("button")
			button.type = "button"
			button.className = "verse-btn"
			if (state?.current?.songId === song.id && state?.current?.verseIndex === verse.index) button.classList.add("active")

			const text = document.createElement("span")
			text.className = "v-text"
			text.textContent = verse.text
			const meta = document.createElement("span")
			meta.className = "v-meta"
			const bound = state?.bindings?.[`${song.id}::${verse.index}`]
			meta.textContent = `${verse.group || "Verse"}${bound ? ` · 📖 ${bound.reference}` : ""}`
			button.append(text, meta)

			button.addEventListener("click", async () => {
				try {
					const result = await api("select", { body: { songId: song.id, verseIndex: verse.index } })
					closeSheet()
					if (result.sendError) toast(result.sendError, true)
					else if (result.sent) toast(`On screen: ${result.sent.reference || result.target}`)
					else if (state?.locked) toast("Locked by PC — verse selected, screen unchanged")
					else toast(`${song.name} · ${verse.group || "Verse"}`)
				} catch (err) {
					toast(err.message, true)
				}
			})
			list.appendChild(button)
		}
	} catch (err) {
		list.innerHTML = `<p class="empty">${err.message}</p>`
	}
}

$("pickerBtn").addEventListener("click", openSheet)
$("sheetClose").addEventListener("click", closeSheet)
$("sheetSearch").addEventListener("input", () => {
	if (sheetMode === "songs") renderSheetSongs()
})
$("sheet").addEventListener("click", (event) => {
	if (event.target === $("sheet")) closeSheet()
})

// ---------------------------------------------------------------- pairing + ws

$("pinForm").addEventListener("submit", async (event) => {
	event.preventDefault()
	const pin = $("pinInput").value.trim()
	if (pin.length < 4) return toast("Enter the 4-digit PIN.", true)
	try {
		const result = await fetch("/api/pair", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pin })
		})
		const data = await result.json()
		if (!result.ok) throw new Error(data.error || "Pairing failed")
		token = data.token
		localStorage.setItem(TOKEN_KEY, token)
		$("gate").hidden = true
		$("app").hidden = false
		await start()
	} catch (err) {
		$("gateMsg").textContent = err.message
		$("pinInput").select()
	}
})

function connect() {
	const protocol = location.protocol === "https:" ? "wss" : "ws"
	socket = new WebSocket(`${protocol}://${location.host}/ws?token=${encodeURIComponent(token)}`)

	socket.addEventListener("message", (event) => {
		let message
		try {
			message = JSON.parse(event.data)
		} catch {
			return
		}
		if (message.type === "state") {
			state = message.state
			render()
			if (!$("sheet").hidden && sheetMode === "songs") renderSheetSongs()
		}
	})

	socket.addEventListener("close", (event) => {
		if (event.code === 4001) return signOut()
		setTimeout(() => {
			if (token) connect()
		}, 1200)
	})
}

async function start() {
	state = await api("state")
	render()
	connect()
}

async function boot() {
	if (!token) {
		$("gate").hidden = false
		$("pinInput").focus()
		return
	}

	try {
		state = await api("state")
		$("gate").hidden = true
		$("app").hidden = false
		render()
		connect()
	} catch (err) {
		signOut()
		$("gateMsg").textContent = err.message
	}
}

boot()
