import fs from "node:fs"
import path from "node:path"

/**
 * The songs FreeShow already has queued for the service.
 *
 * FreeShow keeps them in projects ("schedule" rows, usually named by date) inside
 * Documents/FreeShow/Config/projects.json, next to the Shows folder:
 *   { "projects": { "<id>": { name, created, modified, used, shows: [{ id, index }] } } }
 * Only show ids are listed there, so the caller matches them against the song library
 * and ignores rows that are not songs (videos, presentations, the app's own scratch show).
 *
 * Read-only, cached by file mtime: FreeShow rewrites the file whenever the project changes.
 */

const cache = new Map()

export function projectsFile(showsDir) {
	return path.join(path.dirname(showsDir), "Config", "projects.json")
}

function readProjects(showsDir) {
	const file = projectsFile(showsDir)
	let stat
	try {
		stat = fs.statSync(file)
	} catch (err) {
		return { error: `Cannot read ${file} (${err.code || err.message})`, projects: [] }
	}

	const hit = cache.get(file)
	if (hit && hit.mtime === stat.mtimeMs) return hit.value

	let raw
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"))
	} catch (err) {
		return { error: `Cannot parse ${file} (${err.message})`, projects: [] }
	}

	const projects = Object.entries(raw?.projects || {}).map(([id, project]) => ({
		id,
		name: String(project?.name || "Untitled"),
		// `used` is when it was last opened, `modified` when it was last edited.
		activity: Math.max(Number(project?.modified) || 0, Number(project?.used) || 0),
		shows: (Array.isArray(project?.shows) ? project.shows : [])
			.map((show) => ({ id: String(show?.id || ""), index: Number(show?.index ?? 0) }))
			.filter((show) => show.id)
	}))

	const value = { error: null, projects }
	cache.set(file, { mtime: stat.mtimeMs, value })
	return value
}

/**
 * The project FreeShow was working in most recently.
 * Returns { error, project, showIds } where showIds keeps the schedule order.
 */
export function currentSchedule(showsDir) {
	const { error, projects } = readProjects(showsDir)
	if (error) return { error, project: null, showIds: [] }

	const project = projects.slice().sort((a, b) => b.activity - a.activity)[0] || null
	if (!project) return { error: null, project: null, showIds: [] }

	const showIds = project.shows
		.slice()
		.sort((a, b) => a.index - b.index)
		.map((show) => show.id)

	return { error: null, project: { id: project.id, name: project.name }, showIds }
}
