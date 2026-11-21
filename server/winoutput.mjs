import { spawn } from "node:child_process"
import path from "node:path"
import { ROOT } from "./config.mjs"

/**
 * Whether FreeShow's live output window is actually visible.
 *
 * FreeShow's API has `toggle_output_windows` but no way to read the result back
 * (`get_output` only reports slide data), so this asks Windows for the app's
 * top-level windows. Windows-only; on anything else it reports "unknown".
 */

const SCRIPT = path.join(ROOT, "scripts", "output-windows.ps1")

export function outputWindows({ timeout = 7000 } = {}) {
	if (process.platform !== "win32") {
		return Promise.resolve({ ok: false, visible: false, windows: [], error: "Output window detection is Windows-only" })
	}

	return new Promise((resolve) => {
		let child
		try {
			child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT], { windowsHide: true })
		} catch (err) {
			return resolve({ ok: false, visible: false, windows: [], error: err?.message || String(err) })
		}

		let out = ""
		let done = false
		const finish = (value) => {
			if (done) return
			done = true
			clearTimeout(timer)
			resolve(value)
		}
		const timer = setTimeout(() => {
			try { child.kill() } catch { /* already gone */ }
			finish({ ok: false, visible: false, windows: [], error: "Timed out reading FreeShow windows" })
		}, timeout)

		child.stdout.on("data", (chunk) => { out += chunk })
		child.on("error", (err) => finish({ ok: false, visible: false, windows: [], error: err?.message || String(err) }))
		child.on("close", () => {
			try {
				const parsed = JSON.parse(out)
				finish({ ok: !!parsed.ok, visible: !!parsed.visible, windows: Array.isArray(parsed.windows) ? parsed.windows : [] })
			} catch {
				finish({ ok: false, visible: false, windows: [], error: "Could not read the FreeShow window list" })
			}
		})
	})
}
