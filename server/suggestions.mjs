import crypto from "node:crypto"
import path from "node:path"
import { DATA_DIR, readJson, writeJson } from "./config.mjs"
import { lookup } from "./bible.mjs"

/**
 * Offline scripture suggestions.
 *
 * No internet and no model: each lyric is matched against a curated theme index
 * (worship vocabulary -> passages), the strongest themes supply the passages, and the
 * result is cached per translation + lyric so a service never recomputes anything.
 *
 * This same engine feeds the bulk-prep step (generate suggestions for every verse of
 * every song) — phase two only has to write the chosen passages into FreeShow.
 */

const TOPICS = [
	{ id: "holiness", label: "God's holiness", words: ["holy", "holiness", "worthy", "glorify", "magnify", "sanctify"], refs: ["Isaiah 6:3", "Revelation 4:8", "Psalm 99:9", "1 Samuel 2:2"] },
	{ id: "praise", label: "Praise", words: ["praise", "praises", "sing", "singing", "song", "shout"], refs: ["Psalm 150:6", "Psalm 100:2", "Hebrews 13:15", "Psalm 34:1"] },
	{ id: "worship", label: "Worship", words: ["worship", "bow", "adore", "exalt", "lifted"], refs: ["John 4:24", "Psalm 95:6", "Psalm 29:2", "Romans 12:1"] },
	{ id: "grace", label: "Grace and mercy", words: ["grace", "mercy", "merciful", "favor", "kindness"], refs: ["Ephesians 2:8", "Hebrews 4:16", "2 Corinthians 12:9", "Titus 2:11"] },
	{ id: "salvation", label: "Salvation", words: ["saved", "save", "salvation", "savior", "redeem", "redeemed", "redemption"], refs: ["Romans 10:9", "John 3:16", "Ephesians 2:8", "Psalm 51:12"] },
	{ id: "cross", label: "The cross", words: ["cross", "crucified", "crucify", "calvary", "nails", "thorn"], refs: ["Galatians 6:14", "1 Corinthians 1:18", "Isaiah 53:5", "Colossians 1:20"] },
	{ id: "resurrection", label: "Resurrection", words: ["risen", "resurrection", "raised", "grave", "alive", "empty"], refs: ["1 Corinthians 15:4", "Matthew 28:6", "Romans 6:4", "John 11:25"] },
	{ id: "blood", label: "The blood", words: ["blood", "lamb", "sacrifice", "atonement", "offering"], refs: ["1 John 1:7", "Hebrews 9:22", "Revelation 5:9", "Ephesians 1:7"] },
	{ id: "forgiveness", label: "Forgiveness", words: ["forgive", "forgiveness", "forgiven", "sin", "sins", "cleanse", "wash", "stain"], refs: ["1 John 1:9", "Psalm 103:12", "Micah 7:19", "Acts 3:19"] },
	{ id: "love", label: "God's love", words: ["love", "loved", "loving", "beloved", "cherish"], refs: ["1 John 4:8", "John 3:16", "1 Corinthians 13:4", "Romans 5:8"] },
	{ id: "faith", label: "Faith and trust", words: ["faith", "believe", "believing", "trust", "trusted", "sure"], refs: ["Hebrews 11:1", "Proverbs 3:5", "Mark 9:23", "2 Corinthians 5:7"] },
	{ id: "hope", label: "Hope", words: ["hope", "hoping", "expect", "anchor", "tomorrow"], refs: ["Romans 15:13", "Jeremiah 29:11", "Hebrews 6:19", "Psalm 42:11"] },
	{ id: "peace", label: "Peace", words: ["peace", "still", "calm", "quiet", "rest"], refs: ["Philippians 4:7", "John 14:27", "Isaiah 26:3", "Psalm 4:8"] },
	{ id: "joy", label: "Joy", words: ["joy", "rejoice", "glad", "gladness", "happy", "delight"], refs: ["Nehemiah 8:10", "Psalm 16:11", "Philippians 4:4", "Romans 15:13"] },
	{ id: "strength", label: "Strength", words: ["strength", "strong", "strengthen", "power", "mighty", "weak"], refs: ["Isaiah 40:31", "Philippians 4:13", "Psalm 46:1", "Ephesians 6:10"] },
	{ id: "shepherd", label: "The Shepherd", words: ["shepherd", "sheep", "fold", "pasture", "lead", "leads"], refs: ["Psalm 23:1", "John 10:11", "Isaiah 40:11", "Psalm 100:3"] },
	{ id: "refuge", label: "Refuge", words: ["refuge", "shelter", "fortress", "hiding", "rock", "hide"], refs: ["Psalm 46:1", "Psalm 18:2", "Proverbs 18:10", "Psalm 91:1"] },
	{ id: "healing", label: "Healing", words: ["heal", "healing", "healed", "sick", "sickness", "restore", "whole"], refs: ["Isaiah 53:5", "Psalm 103:3", "Jeremiah 17:14", "James 5:15"] },
	{ id: "prayer", label: "Prayer", words: ["pray", "prayer", "praying", "intercede", "call", "seek"], refs: ["Philippians 4:6", "Jeremiah 33:3", "Matthew 6:9", "1 John 5:14"] },
	{ id: "word", label: "God's word", words: ["word", "scripture", "bible", "truth", "promise", "promises"], refs: ["Psalm 119:105", "Hebrews 4:12", "2 Timothy 3:16", "John 17:17"] },
	{ id: "light", label: "Light", words: ["light", "shine", "shining", "bright", "darkness", "dark", "dawn"], refs: ["John 8:12", "Psalm 119:105", "2 Corinthians 4:6", "Isaiah 60:1"] },
	{ id: "spirit", label: "The Holy Spirit", words: ["spirit", "ghost", "comforter", "breath", "wind", "fill"], refs: ["John 14:26", "Acts 1:8", "Romans 8:26", "Galatians 5:22"] },
	{ id: "fire", label: "Fire", words: ["fire", "flame", "burn", "burning", "refine", "consume"], refs: ["Hebrews 12:29", "Acts 2:3", "Malachi 3:2", "Luke 3:16"] },
	{ id: "water", label: "Water", words: ["water", "river", "stream", "flow", "well", "thirst", "rain"], refs: ["John 4:14", "Isaiah 55:1", "Revelation 22:17", "Psalm 42:1"] },
	{ id: "heaven", label: "Heaven", words: ["heaven", "heavens", "throne", "eternal", "eternity", "forever"], refs: ["Revelation 21:4", "2 Corinthians 4:17", "John 14:2", "Isaiah 66:1"] },
	{ id: "kingdom", label: "The kingdom", words: ["kingdom", "king", "reign", "reigning", "sovereign", "rule"], refs: ["Matthew 6:10", "Psalm 103:19", "Daniel 4:3", "Revelation 11:15"] },
	{ id: "creation", label: "Creation", words: ["creation", "created", "creator", "earth", "universe", "world", "mountain", "sea"], refs: ["Genesis 1:1", "Psalm 19:1", "Colossians 1:16", "Isaiah 45:18"] },
	{ id: "name", label: "The name of Jesus", words: ["name", "jesus", "christ", "savior", "messiah"], refs: ["Philippians 2:9", "Psalm 8:1", "Proverbs 18:10", "Acts 4:12"] },
	{ id: "freedom", label: "Freedom", words: ["free", "freedom", "liberty", "chains", "bondage", "captive"], refs: ["John 8:36", "Galatians 5:1", "Isaiah 61:1", "2 Corinthians 3:17"] },
	{ id: "broken", label: "Brokenness", words: ["broken", "brokenhearted", "cry", "crying", "tears", "weep", "sorrow", "grief"], refs: ["Psalm 34:18", "Psalm 147:3", "Matthew 5:4", "Revelation 21:4"] },
	{ id: "fear", label: "Fear and worry", words: ["fear", "afraid", "anxious", "worry", "troubled", "storm"], refs: ["Isaiah 41:10", "Psalm 56:3", "2 Timothy 1:7", "Joshua 1:9"] },
	{ id: "waiting", label: "Waiting", words: ["wait", "waiting", "patience", "endure", "patient"], refs: ["Isaiah 40:31", "Psalm 27:14", "Lamentations 3:25", "Romans 12:12"] },
	{ id: "obedience", label: "Following Jesus", words: ["obey", "obedience", "follow", "following", "surrender", "yield"], refs: ["John 14:15", "1 Samuel 15:22", "Luke 9:23", "James 1:22"] },
	{ id: "thanks", label: "Thankfulness", words: ["thanks", "thank", "thankful", "gratitude", "grateful", "bless"], refs: ["1 Thessalonians 5:18", "Psalm 107:1", "Colossians 3:17", "Psalm 100:4"] },
	{ id: "church", label: "The church", words: ["church", "body", "gather", "together", "saints", "brothers", "sisters"], refs: ["Matthew 18:20", "Hebrews 10:25", "Acts 2:42", "1 Corinthians 12:27"] },
	{ id: "mission", label: "Mission", words: ["nations", "gospel", "witness", "send", "sent", "everyone"], refs: ["Matthew 28:19", "Acts 1:8", "Mark 16:15", "Romans 10:15"] },
	{ id: "humility", label: "Humility", words: ["humble", "humility", "lowly", "meek", "serve", "servant"], refs: ["1 Peter 5:6", "Philippians 2:3", "Matthew 11:29", "James 4:10"] },
	{ id: "rest", label: "Rest", words: ["rest", "weary", "tired", "labour", "labor", "burden"], refs: ["Matthew 11:28", "Psalm 23:2", "Hebrews 4:9", "Exodus 33:14"] },
	{ id: "victory", label: "Victory", words: ["victory", "overcome", "conquer", "triumph", "win", "battle"], refs: ["1 Corinthians 15:57", "Romans 8:37", "1 John 5:4", "Revelation 12:11"] },
	{ id: "promise", label: "God's promises", words: ["covenant", "faithful", "faithfulness", "promised"], refs: ["2 Corinthians 1:20", "Hebrews 10:23", "Psalm 145:13", "Joshua 21:45"] },
	{ id: "family", label: "Family and home", words: ["family", "children", "home", "house", "father", "mother"], refs: ["Joshua 24:15", "Psalm 127:3", "Proverbs 22:6", "Ephesians 3:15"] },
	{ id: "giving", label: "Generosity", words: ["give", "giving", "gift", "generous", "sow", "sowing"], refs: ["2 Corinthians 9:7", "Luke 6:38", "Proverbs 11:25", "Malachi 3:10"] },
	{ id: "suffering", label: "Suffering", words: ["suffer", "suffering", "trial", "trials", "affliction", "pain", "hardship"], refs: ["Romans 5:3", "2 Corinthians 4:17", "1 Peter 1:7", "James 1:2"] },
	{ id: "coming", label: "Christ's return", words: ["coming", "return", "soon", "bridegroom", "midnight"], refs: ["Revelation 22:20", "Matthew 24:42", "1 Thessalonians 4:16", "Titus 2:13"] }
]

const FALLBACK_REFS = ["Psalm 119:105", "Proverbs 3:5", "Isaiah 40:31", "Philippians 4:13", "Romans 8:28"]

const CACHE_FILE = path.join(DATA_DIR, "suggestions-cache.json")
let cache = null
let cacheDirty = false
let flushTimer = null

function getCache() {
	if (!cache) cache = readJson(CACHE_FILE, {})
	return cache
}

function flushSoon() {
	if (flushTimer) return
	flushTimer = setTimeout(() => {
		flushTimer = null
		if (!cacheDirty) return
		cacheDirty = false
		writeJson(CACHE_FILE, cache || {})
	}, 400)
}

const keyFor = (translation, text) => `${translation}:${crypto.createHash("sha1").update(text).digest("hex").slice(0, 16)}`

const tokenize = (text) => String(text || "").toLowerCase().match(/[a-z']+/g) || []

function wordHits(tokens, word) {
	const w = word.toLowerCase()
	let hits = 0
	for (const token of tokens) {
		if (token === w) hits += 1
		else if (w.length >= 4 && (token.startsWith(w) || w.startsWith(token)) && Math.abs(token.length - w.length) <= 3) hits += 0.8
	}
	return hits
}

/** Rank themes for a lyric (plus song context), then pick passages round-robin. */
export function rankThemes({ text, context = "" }) {
	const tokens = tokenize(text)
	const contextTokens = tokenize(context)
	const ranked = []
	for (const topic of TOPICS) {
		let score = 0
		for (const word of topic.words) score += wordHits(tokens, word) + wordHits(contextTokens, word) * 0.5
		if (score > 0) ranked.push({ topic, score })
	}
	ranked.sort((a, b) => b.score - a.score)
	return ranked
}

/**
 * Suggestions for a lyric: 3-5 passages, offline, deterministic, cached.
 * @returns {{ reference: string, text: string, preview: string, topic: string, topicLabel: string, translation: string }[]}
 */
export function suggest({ text, context = "", translation = "KJV", limit = 5 }) {
	const lyric = String(text || "").trim()
	const key = keyFor(translation, `${lyric}\u0000${context}\u0000${limit}`)
	const store = getCache()

	let entry = store[key]
	if (!entry || !Array.isArray(entry.items) || !entry.items.length) {
		const ranked = rankThemes({ text: lyric, context })
		const picked = []
		const seen = new Set()
		const add = (ref, topic, topicLabel) => {
			if (!ref || seen.has(ref.toLowerCase())) return false
			seen.add(ref.toLowerCase())
			picked.push({ reference: ref, topic, topicLabel })
			return true
		}

		// one passage per theme first, so five cards are five different angles
		for (const { topic } of ranked) {
			add(topic.refs[0], topic.id, topic.label)
			if (picked.length >= limit) break
		}

		// a thin match gets more passages from the themes it did hit
		if (picked.length < 3) {
			for (const { topic } of ranked) {
				for (const ref of topic.refs.slice(1)) {
					add(ref, topic.id, topic.label)
					if (picked.length >= 3) break
				}
				if (picked.length >= 3) break
			}
		}

		// no theme matched at all: stand on general passages
		for (const ref of FALLBACK_REFS) {
			if (picked.length >= 3) break
			add(ref, "general", "General")
		}

		entry = { items: picked, at: Date.now() }
		store[key] = entry
		cacheDirty = true
		flushSoon()
	}

	const out = []
	for (const item of entry.items) {
		const resolved = lookup(translation, item.reference)
		if (!resolved.ok) continue
		out.push({
			reference: resolved.reference,
			text: resolved.text,
			theme: item.topicLabel,
			translation: resolved.translation
		})
	}
	return out.slice(0, limit)
}

export function topics() {
	return TOPICS.map(({ id, label, refs }) => ({ id, label, refs }))
}
