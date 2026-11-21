/**
 * Build the folder that travels to the church PC.
 *
 *   node scripts/make-church-copy.mjs                       (default target: ../Live Scripture Control (church PC))
 *   node scripts/make-church-copy.mjs "D:\Church PC\Live Scripture Control"
 *   node scripts/make-church-copy.mjs --with-installer      (also copy the two installers into installer\)
 *
 * The copy is the app source only: no `dist\` build output (585 MB of win-unpacked, blockmaps and
 * debug files), no `node_modules`, no editor/chat folders, and none of this PC's own state
 * (`config.json` carries this machine's song-library path, PIN and paired phones; `data/session.json`
 * is whatever was on screen).
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const withInstaller = args.includes("--with-installer")
const targetArg = args.find((arg) => !arg.startsWith("--"))
const TARGET = path.resolve(ROOT, targetArg || path.join("..", "Live Scripture Control (church PC)"))

const SKIP_NAMES = new Set([
	"node_modules",
	"dist",
	".freebuff",
	".cloud-attachments",
	".git",
	"config.json",
	"session.json",
])
const SKIP_EXT = new Set([".log"])

if (TARGET === ROOT || TARGET.startsWith(ROOT + path.sep)) {
	console.error(`Refusing to copy into ${TARGET}: choose a folder outside this project.`)
	process.exit(1)
}

if (fs.existsSync(TARGET)) {
	// Only replace a folder that looks like an earlier copy, so a mistyped path cannot wipe
	// something that is not ours.
	const mine = ["package.json", "server", "README.md"].every((name) => fs.existsSync(path.join(TARGET, name)))
	if (!mine) {
		console.error(`${TARGET} already exists and does not look like an earlier copy. Move it away first.`)
		process.exit(1)
	}
	fs.rmSync(TARGET, { recursive: true, force: true })
}

fs.mkdirSync(TARGET, { recursive: true })
fs.cpSync(ROOT, TARGET, {
	recursive: true,
	filter(source) {
		const name = path.basename(source)
		if (SKIP_NAMES.has(name)) return false
		if (SKIP_EXT.has(path.extname(name))) return false
		return true
	},
})

let installed = []
if (withInstaller) {
	const dist = path.join(ROOT, "dist")
	const wanted = fs.existsSync(dist)
		? fs
				.readdirSync(dist)
				.filter((file) => file.endsWith(".exe") && !file.startsWith("Uninstall"))
				.map((file) => path.join(dist, file))
		: []
	const out = path.join(TARGET, "installer")
	fs.mkdirSync(out, { recursive: true })
	for (const file of wanted) {
		fs.copyFileSync(file, path.join(out, path.basename(file)))
		installed.push(path.basename(file))
	}
	if (!wanted.length) console.log("  ! no installers found in dist — run npm run dist first")
}

function size(dir) {
	let total = 0
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) total += size(full)
		else total += fs.statSync(full).size
	}
	return total
}

console.log("")
console.log(`  Built the church-PC folder: ${TARGET}`)
console.log("")
for (const entry of fs.readdirSync(TARGET, { withFileTypes: true })) {
	console.log(`  ${entry.isDirectory() ? "dir " : "file"}  ${entry.name}`)
}
console.log("")
console.log(`  ${(size(TARGET) / 1048576).toFixed(1)} MB, no dist build output, no node_modules, no config.json`)
if (installed.length) console.log(`  installers copied: ${installed.join(", ")}`)
console.log("")
console.log("  Next on the church PC: open the folder, double-click \"Check setup.cmd\", then \"Start Live Scripture.cmd\".")
console.log("  (Or install installer\\Live Scripture Control Setup 1.0.0.exe and skip both.)")
console.log("")
