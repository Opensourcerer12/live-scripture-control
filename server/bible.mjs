import fs from "node:fs"
import path from "node:path"
import { DATA_DIR } from "./config.mjs"

/**
 * Offline Bible.
 *
 * KJV ships in data/kjv.json (public domain, 31,102 verses).
 * NIV and ESV are copyrighted, so they are never bundled: the app enables them only when
 * a licensed file with the same schema exists at data/niv.json / data/esv.json.
 *
 * Schema: [{ abbrev, name, chapters: [[verseText, ...], ...] }, ...]
 */

export const TRANSLATIONS = {
	KJV: {
		id: "KJV",
		name: "King James Version",
		file: "kjv.json",
		bundled: true,
		note: "Public domain — included."
	},
	NIV: {
		id: "NIV",
		name: "New International Version",
		file: "niv.json",
		bundled: false,
		note: "Copyrighted. Not bundled — add your licensed data/niv.json to enable."
	},
	ESV: {
		id: "ESV",
		name: "English Standard Version",
		file: "esv.json",
		bundled: false,
		note: "Copyrighted. Not bundled — add your licensed data/esv.json to enable."
	}
}

const ALIASES = {
	genesis: ["gen", "ge", "gn"],
	exodus: ["ex", "exo", "exod"],
	leviticus: ["lev", "lv", "le"],
	numbers: ["num", "nm", "nb"],
	deuteronomy: ["deut", "dt", "de"],
	joshua: ["josh", "jos"],
	judges: ["judg", "jdg", "jg"],
	ruth: ["rth", "ru"],
	"1 samuel": ["1sam", "1sa", "1sm", "1smuel"],
	"2 samuel": ["2sam", "2sa", "2sm"],
	"1 kings": ["1kgs", "1ki", "1k"],
	"2 kings": ["2kgs", "2ki", "2k"],
	"1 chronicles": ["1chr", "1ch"],
	"2 chronicles": ["2chr", "2ch"],
	ezra: ["ezr"],
	nehemiah: ["neh", "ne"],
	esther: ["est", "es"],
	job: ["jb"],
	psalms: ["ps", "psa", "psalm", "pslm", "pss", "psm"],
	proverbs: ["prov", "pr", "prv"],
	ecclesiastes: ["eccl", "ecc", "ec"],
	"song of solomon": ["song", "sos", "ss", "canticles", "songofsongs"],
	isaiah: ["isa", "is"],
	jeremiah: ["jer", "je"],
	lamentations: ["lam", "la"],
	ezekiel: ["ezek", "eze", "ezk"],
	daniel: ["dan", "dn", "da"],
	hosea: ["hos", "ho"],
	joel: ["joe", "jl"],
	amos: ["am"],
	obadiah: ["obad", "ob"],
	jonah: ["jon", "jnh"],
	micah: ["mic", "mc"],
	nahum: ["nah", "na"],
	habakkuk: ["hab", "hb"],
	zephaniah: ["zeph", "zep", "zp"],
	haggai: ["hag", "hg"],
	zechariah: ["zech", "zec", "zc"],
	malachi: ["mal", "ml"],
	matthew: ["matt", "mt", "mat"],
	mark: ["mk", "mrk", "mar"],
	luke: ["lk", "luk", "lu"],
	john: ["jn", "joh"],
	acts: ["ac", "act"],
	romans: ["rom", "ro", "rm"],
	"1 corinthians": ["1cor", "1co"],
	"2 corinthians": ["2cor", "2co"],
	galatians: ["gal", "ga"],
	ephesians: ["eph", "ep"],
	philippians: ["phil", "php", "philip"],
	colossians: ["col", "cl"],
	"1 thessalonians": ["1thess", "1th", "1thes"],
	"2 thessalonians": ["2thess", "2th", "2thes"],
	"1 timothy": ["1tim", "1ti"],
	"2 timothy": ["2tim", "2ti"],
	titus: ["tit", "ti"],
	philemon: ["philem", "phm"],
	hebrews: ["heb", "hbr"],
	james: ["jas", "jm"],
	"1 peter": ["1pet", "1pe"],
	"2 peter": ["2pet", "2pe"],
	"1 john": ["1jn", "1joh"],
	"2 john": ["2jn", "2joh"],
	"3 john": ["3jn", "3joh"],
	jude: ["jud", "jd"],
	revelation: ["rev", "re", "rv", "apocalypse"]
}

const normalize = (value) =>
	String(value || "")
		.toLowerCase()
		.replace(/[.'’]/g, "")
		.replace(/\s+/g, " ")
		.trim()

const loaded = new Map()

export function availableTranslations() {
	const out = {}
	for (const [id, meta] of Object.entries(TRANSLATIONS)) {
		out[id] = { ...meta, available: fs.existsSync(path.join(DATA_DIR, meta.file)) }
	}
	return out
}

export function loadBible(translation = "KJV") {
	const id = String(translation || "KJV").toUpperCase()
	if (loaded.has(id)) return loaded.get(id)

	const meta = TRANSLATIONS[id] || TRANSLATIONS.KJV
	const file = path.join(DATA_DIR, meta.file)
	let books = []
	try {
		books = JSON.parse(fs.readFileSync(file, "utf8"))
	} catch {
		books = []
	}

	if (!Array.isArray(books) || !books.length) {
		const bible = { id, ok: false, error: `${meta.name} is not installed (${path.relative(process.cwd(), file)})`, books: [], index: new Map() }
		loaded.set(id, bible)
		return bible
	}

	const index = new Map()
	for (const book of books) {
		const name = normalize(book.name)
		index.set(name, book)
		index.set(name.replace(/\s+/g, ""), book)
		if (book.abbrev) index.set(normalize(book.abbrev), book)
	}
	for (const [name, aliases] of Object.entries(ALIASES)) {
		const book = index.get(normalize(name))
		if (!book) continue
		index.set(normalize(name), book)
		for (const alias of aliases) index.set(normalize(alias), book)
	}

	const bible = { id, ok: true, name: meta.name, books, index }
	loaded.set(id, bible)
	return bible
}

export function findBook(bible, name) {
	const key = normalize(name)
	return bible.index.get(key) || bible.index.get(key.replace(/\s+/g, "")) || null
}

const REF_RE = /^\s*([1-3]?\s*[a-z][a-z.'’\s]*?)\s*(\d{1,3})(?:\s*[:.]\s*(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?)?\s*$/i

export function parseReference(input) {
	const match = String(input || "").trim().match(REF_RE)
	if (!match) return null
	const [, book, chapter, verse, end] = match
	return {
		book: book.trim(),
		chapter: Number(chapter),
		verse: verse ? Number(verse) : null,
		end: end ? Number(end) : null
	}
}

/**
 * Resolve "John 3:16", "Rom 8:28-30" or "Psalm 23" against a translation.
 * Returns { ok, reference, text, verses, translation } or { ok:false, error }.
 */
export function lookup(translation, input) {
	const bible = loadBible(translation)
	if (!bible.ok) return { ok: false, error: bible.error }

	const parsed = parseReference(input)
	if (!parsed) return { ok: false, error: `Could not read "${input}". Try John 3:16, Rom 8:28-30 or Psalm 23.` }

	const book = findBook(bible, parsed.book)
	if (!book) return { ok: false, error: `Unknown book "${parsed.book}".` }

	const chapters = book.chapters || []
	const chapter = chapters[parsed.chapter - 1]
	if (!chapter) return { ok: false, error: `${book.name} has no chapter ${parsed.chapter}.` }

	const canonical = (verse, end) => `${book.name} ${parsed.chapter}:${verse}${end && end !== verse ? `-${end}` : ""}`

	if (parsed.verse === null) {
		const verses = chapter.slice(0, 40).map((text, i) => ({ verse: i + 1, text }))
		return {
			ok: true,
			reference: `${book.name} ${parsed.chapter}`,
			bookName: book.name,
			chapter: parsed.chapter,
			verses,
			text: verses.map((v) => v.text).join(" "),
			translation: bible.id,
			truncated: chapter.length > 40
		}
	}

	if (!chapter[parsed.verse - 1]) return { ok: false, error: `${book.name} ${parsed.chapter} has no verse ${parsed.verse}.` }

	const start = parsed.verse
	const end = Math.min(parsed.end || start, chapter.length, start + 11)
	const verses = []
	for (let v = start; v <= end; v++) verses.push({ verse: v, text: chapter[v - 1] })

	return {
		ok: true,
		reference: canonical(start, end),
		bookName: book.name,
		chapter: parsed.chapter,
		verses,
		text: verses.map((v) => v.text).join(" "),
		translation: bible.id
	}
}

/** Short text for a suggestion card; the app shows a trimmed preview. */
export function preview(text, max = 190) {
	const clean = String(text || "").replace(/\s+/g, " ").trim()
	return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}
