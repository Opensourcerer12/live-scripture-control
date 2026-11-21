/**
 * Desktop shell for Live Scripture Control.
 *
 * The app is still the same local server + web page; this window only replaces "open a
 * terminal and a browser". The server runs inside this process, so the church PC needs no
 * separate Node.js install.
 */
const { app, BrowserWindow, Menu, dialog, shell } = require("electron")
const fs = require("node:fs")
const net = require("node:net")
const path = require("node:path")
const http = require("node:http")
const { pathToFileURL } = require("node:url")

const APP_ROOT = path.join(__dirname, "..")
// Writable data lives in %APPDATA% when installed; LSC_STATE_DIR can point it elsewhere
// (used by tests, and by anyone who wants a self-contained folder).
const STATE_DIR = process.env.LSC_STATE_DIR ? path.resolve(process.env.LSC_STATE_DIR) : app.getPath("userData")
process.env.LSC_STATE_DIR = STATE_DIR
const LOG_FILE = path.join(STATE_DIR, "server.log")
const DEFAULT_PORT = 8099

let server = null
let win = null
let quitting = false
let port = DEFAULT_PORT

function readPort() {
	if (process.env.LSC_PORT) return Number(process.env.LSC_PORT)
	try {
		const config = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "config.json"), "utf8"))
		if (Number.isInteger(config.appPort) && config.appPort > 0) return config.appPort
	} catch {
		/* first run: the server writes a default config */
	}
	return DEFAULT_PORT
}

function log(line) {
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true })
		fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
	} catch {
		/* logging must never break the app */
	}
}

async function startServer() {
	// The server is an ES module with top-level startup, so importing it starts it. It reads
	// LSC_STATE_DIR from the environment, which is set above.
	const entry = pathToFileURL(path.join(APP_ROOT, "server", "index.mjs")).href
	try {
		server = await import(entry)
		log(`server module loaded (port ${port})`)
	} catch (err) {
		log(`[error] server failed to start: ${err && err.stack ? err.stack : err}`)
		dialog.showMessageBoxSync({
			type: "error",
			title: "Live Scripture Control",
			message: "The control server could not start.",
			detail: `${err && err.message ? err.message : err}\n\nLog file: ${LOG_FILE}`,
			buttons: ["OK"],
		})
		quitting = true
		app.quit()
	}
}

function portBusy(target) {
	return new Promise((resolve) => {
		const socket = net.connect({ port: target, host: "127.0.0.1" })
		const finish = (value) => {
			socket.destroy()
			resolve(value)
		}
		socket.setTimeout(900)
		socket.once("connect", () => finish(true))
		socket.once("timeout", () => finish(false))
		socket.once("error", () => finish(false))
	})
}

function waitForServer(timeoutMs = 30000) {
	const started = Date.now()
	return new Promise((resolve) => {
		const attempt = () => {
			const request = http.get({ host: "127.0.0.1", port, path: "/api/state", timeout: 1500 }, (response) => {
				response.resume()
				if (response.statusCode === 200) resolve(true)
				else retry()
			})
			request.on("error", retry)
			request.on("timeout", () => {
				request.destroy()
				retry()
			})
		}
		const retry = () => {
			if (Date.now() - started > timeoutMs) return resolve(false)
			setTimeout(attempt, 400)
		}
		attempt()
	})
}

async function runDoctor() {
	try {
		const entry = pathToFileURL(path.join(APP_ROOT, "server", "checks.mjs")).href
		const { runChecks } = await import(entry)
		const { lines, problems } = await runChecks()
		return `${lines.join("\n")}\n\n${problems ? `${problems} thing(s) to look at.` : "Everything checks out."}`
	} catch (err) {
		return `The check could not run: ${err && err.message ? err.message : err}`
	}
}

function buildMenu() {
	const template = [
		{
			label: "File",
			submenu: [
				{
					label: "Check setup…",
					async click() {
						const report = await runDoctor()
						dialog.showMessageBox(win, {
							type: "info",
							title: "Setup check",
							message: "What this PC is set up for",
							detail: report,
							buttons: ["OK"],
						})
					},
				},
				{
					label: "Open log file",
					click() { shell.showItemInFolder(LOG_FILE) },
				},
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
				{ role: "toggleDevTools" },
			],
		},
		{
			label: "Help",
			submenu: [
				{
					label: "About",
					click() {
						dialog.showMessageBox(win, {
							type: "info",
							title: "Live Scripture Control",
							message: `Live Scripture Control ${app.getVersion()}`,
							detail: "Puts a song lyric and a chosen scripture on the projector through FreeShow.\n\nPhone remote: open /phone on the address shown in the app.",
							buttons: ["OK"],
						})
					},
				},
			],
		},
	]
	Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow() {
	win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1000,
		minHeight: 640,
		backgroundColor: "#141a26",
		title: "Live Scripture Control",
		icon: path.join(APP_ROOT, "build", "icon.png"),
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			spellcheck: false,
		},
	})

	win.once("ready-to-show", () => win.show())
	win.webContents.on("did-fail-load", (_event, code, description, url) => {
		log(`page failed to load (${code} ${description}) ${url}`)
	})
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("http://localhost") || url.startsWith(`http://127.0.0.1:${port}`)) return { action: "allow" }
		shell.openExternal(url)
		return { action: "deny" }
	})

	await win.loadURL(`http://127.0.0.1:${port}/`)
	win.on("closed", () => { win = null })
}

if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on("second-instance", () => {
		if (!win) return
		if (win.isMinimized()) win.restore()
		win.focus()
	})

	app.whenReady().then(async () => {
		app.setAppUserModelId("com.livescripture.control")
		port = readPort()
		log(`starting app, port ${port}, state ${STATE_DIR}`)
		buildMenu()

		if (await portBusy(port)) {
			dialog.showMessageBoxSync({
				type: "error",
				title: "Live Scripture Control",
				message: `Port ${port} is already in use.`,
				detail: "Another copy of the app (or another program) is using that port. Close it and start the app again.",
				buttons: ["OK"],
			})
			quitting = true
			return app.quit()
		}

		await startServer()

		const ready = await waitForServer()
		if (!ready) {
			dialog.showMessageBoxSync({
				type: "error",
				title: "Live Scripture Control",
				message: "The app did not start.",
				detail: `Nothing answered on port ${port}.\n\nLog file: ${LOG_FILE}\n\nAnother program may already be using that port.`,
				buttons: ["OK"],
			})
			quitting = true
			return app.quit()
		}

		await createWindow()
	})

	app.on("window-all-closed", () => app.quit())

	app.on("before-quit", () => {
		// The HTTP server lives in this process, so quitting shuts it down.
		quitting = true
	})
}
