// pure logic without DOM: works in the browser (window.VKRC) and in Node (require) for tests
;(function (root, factory) {
	const lib = factory()
	if (typeof module === "object" && module.exports) module.exports = lib
	else root.VKRC = lib
})(typeof self !== "undefined" ? self : this, function () {
	"use strict"

	// ---------- token ----------

	// accepts the full blank.html url (vk.com or vk.ru), just its fragment or a bare token
	const parseToken = input => {
		const text = String(input || "").trim()
		if (!text) return {error: "empty"}

		const params = {}
		text.replace(/(?:^|[?#&])([a-z_]+)=([^&#\s]*)/gi, (match, key, value) => {
			try {
				params[key.toLowerCase()] = decodeURIComponent(value)
			} catch (e) {
				params[key.toLowerCase()] = value
			}
		})

		if (params.error) {
			return {error: "denied", description: (params.error_description || "").replace(/\+/g, " ")}
		}
		if (params.access_token) {
			return {
				token: params.access_token,
				userId: Number(params.user_id) || null,
				expiresIn: params.expires_in === undefined ? null : Number(params.expires_in),
			}
		}
		if (/^[\w.-]{20,}$/.test(text)) return {token: text, userId: null, expiresIn: null}
		return {error: "invalid"}
	}

	// ---------- comment links ----------

	// matches links like https://vk.ru/wall-123_456?reply=789&amp;thread=1010 with any vk domain or none at all
	const LINK_RE =
		/(?:(?:https?:)?\/\/)?(?:(?:[a-z0-9-]+\.)*(?:vk\.com|vk\.ru|vkontakte\.ru))?\/(wall|photo|video|market)(-?\d+)_(\d+)\?([^"'<>\s]*)/gi

	const extractCommentLinks = text => {
		const links = []
		String(text).replace(LINK_RE, (match, type, ownerId, postId, query) => {
			const params = {}
			query
				.replace(/&amp;|&#0*38;/gi, "&")
				.split("&")
				.forEach(pair => {
					const [key, value] = pair.split("=")
					if (key && /^\d+$/.test(value || "")) params[key] = Number(value)
				})
			if (!params.reply) return //a link to a post, not to a comment
			links.push({
				type: type.toLowerCase(),
				ownerId: Number(ownerId),
				postId: Number(postId),
				reply: params.reply,
				thread: params.thread && params.thread !== params.reply ? params.thread : null,
			})
		})
		return links
	}

	// only files inside a "comments" folder: other sections (likes!) link to other people's comments
	const isCommentsPath = path => {
		const parts = String(path).split(/[\\/]/)
		const name = parts[parts.length - 1]
		if (parts.includes("__MACOSX") || name.startsWith("._")) return false
		return /\.html?$/i.test(name) && parts.slice(0, -1).some(part => part.toLowerCase() === "comments")
	}

	const commentKey = link => `${link.type}${link.ownerId}_${link.reply}${link.thread ? `_${link.thread}` : ""}`

	const commentUrl = comment =>
		`https://vk.ru/wall${comment.ownerId}_${comment.postId}?reply=${comment.reply}${
			comment.thread ? `&thread=${comment.thread}` : ""
		}`

	const buildQueue = links => {
		const seen = new Set()
		const queue = []
		const unsupported = {}
		let duplicates = 0
		links.forEach(link => {
			const key = commentKey(link)
			if (seen.has(key)) {
				duplicates++
				return
			}
			seen.add(key)
			if (link.type === "wall") queue.push({...link, key})
			else unsupported[link.type] = (unsupported[link.type] || 0) + 1
		})
		return {queue, unsupported, duplicates, total: links.length}
	}

	// short stable id of the queue, used as the key for saved progress
	const hashKeys = keys => {
		let hash = 0x811c9dc5
		const text = keys.slice().sort().join(",")
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i)
			hash = Math.imul(hash, 0x01000193) >>> 0
		}
		return hash.toString(16)
	}

	// ---------- zip ----------

	const ZipError = class extends Error {}

	// reads only the central directory, so big archives are not loaded into memory
	const listZip = async blob => {
		const tailSize = Math.min(blob.size, 22 + 0xffff)
		const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer())
		let eocd = -1
		for (let i = tailSize - 22; i >= 0; i--) {
			if (tail.getUint32(i, true) === 0x06054b50) {
				eocd = i
				break
			}
		}
		if (eocd < 0) throw new ZipError("Это не zip-архив или он повреждён")

		const count = tail.getUint16(eocd + 10, true)
		const dirSize = tail.getUint32(eocd + 12, true)
		const dirOffset = tail.getUint32(eocd + 16, true)
		if (count === 0xffff || dirOffset === 0xffffffff) {
			throw new ZipError("Архив слишком большой (zip64). Запросите архив только с комментариями")
		}

		const dir = new DataView(await blob.slice(dirOffset, dirOffset + dirSize).arrayBuffer())
		const decoder = new TextDecoder()
		const entries = []
		let p = 0
		for (let n = 0; n < count; n++) {
			if (dir.getUint32(p, true) !== 0x02014b50) throw new ZipError("Архив повреждён")
			const nameLength = dir.getUint16(p + 28, true)
			const extraLength = dir.getUint16(p + 30, true)
			const commentLength = dir.getUint16(p + 32, true)
			entries.push({
				name: decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength)),
				encrypted: (dir.getUint16(p + 8, true) & 1) === 1,
				method: dir.getUint16(p + 10, true),
				compressedSize: dir.getUint32(p + 20, true),
				offset: dir.getUint32(p + 42, true),
			})
			p += 46 + nameLength + extraLength + commentLength
		}
		return entries
	}

	const readZipEntry = async (blob, entry) => {
		if (entry.encrypted) throw new ZipError(`Файл ${entry.name} зашифрован`)
		const header = new DataView(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer())
		if (header.getUint32(0, true) !== 0x04034b50) throw new ZipError("Архив повреждён")
		const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true)
		const data = blob.slice(start, start + entry.compressedSize)
		if (entry.method === 0) return new Uint8Array(await data.arrayBuffer())
		if (entry.method === 8) {
			const stream = data.stream().pipeThrough(new DecompressionStream("deflate-raw"))
			return new Uint8Array(await new Response(stream).arrayBuffer())
		}
		throw new ZipError(`Неподдерживаемый способ сжатия в файле ${entry.name}`)
	}

	// ---------- api errors ----------

	// what to do with a vk api error code
	const classifyError = code => {
		if (code === 6) return "slowdown" //too many requests per second
		if (code === 10) return "retry" //internal server error
		if (code === 9) return "flood" //flood control
		if (code === 29) return "quota" //rate limit for the method is reached
		if (code === 5) return "auth" //token is invalid or expired
		if (code === 14) return "captcha"
		if (code === 17) return "validation" //vk wants the user to confirm something in the browser
		if ([7, 15, 18, 30, 100, 104, 211, 212, 213].includes(code)) return "skip" //no access or nothing to delete
		return "unknown"
	}

	// errors after which the comment should be tried again later
	const isTransient = kind => !["skip", "unknown"].includes(kind)

	// ---------- execute ----------

	// vkscript that checks authorship and deletes up to 8 comments per request (up to 24 api calls, the limit is 25).
	// every comment has up to two candidate ids: reply and thread. the first one that belongs to the user is deleted,
	// so another person's comment is never touched whatever the archive links mean.
	// output is a flat array of scalars: "e" = getComment failed, number = from_id (0 = no such comment),
	// "D" = deleted, "X" = delete failed
	const buildExecuteCode = (batch, userId, dryRun) => {
		const list = JSON.stringify(batch.map(comment => [comment.ownerId, comment.reply, comment.thread || 0]))
		return `var me = ${Number(userId)};
var dry = ${dryRun ? 1 : 0};
var list = ${list};
var out = [];
var i = 0;
while (i < list.length) {
	var o = list[i][0];
	var hit = 0;
	var j = 1;
	while (j < 3) {
		var c = list[i][j];
		if (hit == 0 && c != 0) {
			var g = API.wall.getComment({"owner_id": o, "comment_id": c});
			if (g) {
				var from = 0;
				if (g.items.length > 0) {
					from = g.items[0].from_id;
				}
				out.push(from);
				if (from == me) {
					hit = j;
					if (dry == 0) {
						if (API.wall.deleteComment({"owner_id": o, "comment_id": c})) {
							out.push("D");
						} else {
							out.push("X");
						}
					}
				}
			} else {
				out.push("e");
			}
		}
		j = j + 1;
	}
	i = i + 1;
}
return out;`
	}

	// walks the flat output exactly like the vkscript did and matches failed calls with execute_errors in order
	const interpretExecute = (batch, data, userId, dryRun) => {
		const steps = data.response
		const errors = (data.execute_errors || []).slice()
		if (!Array.isArray(steps)) throw new Error("Unexpected execute response")
		let position = 0
		const nextStep = () => {
			if (position >= steps.length) throw new Error("Execute response is shorter than expected")
			return steps[position++]
		}
		const nextError = () => {
			const error = errors.shift()
			return error ? {code: error.error_code, message: error.error_msg} : {code: 0, message: "unknown error"}
		}

		return batch.map(comment => {
			const candidates = [
				["reply", comment.reply],
				["thread", comment.thread],
			].filter(([, id]) => id)
			let matched = null
			let deleted = false
			let deleteError = null
			let sawOtherAuthor = false
			const getErrors = []

			for (const [name] of candidates) {
				if (matched) break
				const step = nextStep()
				if (step === "e") {
					getErrors.push(nextError())
					continue
				}
				if (!step) continue //the comment no longer exists
				if (Number(step) === Number(userId)) {
					matched = name
					if (!dryRun) {
						if (nextStep() === "D") deleted = true
						else deleteError = nextError()
					}
				} else sawOtherAuthor = true
			}

			if (matched && dryRun) return {status: "wouldDelete", matched}
			if (matched && deleted) return {status: "deleted", matched}
			if (matched) {
				const kind = classifyError(deleteError.code)
				return {status: isTransient(kind) ? "retry" : "failed", matched, kind, error: deleteError}
			}
			const transient = getErrors.find(error => isTransient(classifyError(error.code)))
			if (transient) return {status: "retry", kind: classifyError(transient.code), error: transient}
			if (sawOtherAuthor) return {status: "notMine"}
			return {status: "gone", error: getErrors[getErrors.length - 1] || null}
		})
	}

	return {
		parseToken,
		extractCommentLinks,
		isCommentsPath,
		commentKey,
		commentUrl,
		buildQueue,
		hashKeys,
		ZipError,
		listZip,
		readZipEntry,
		classifyError,
		isTransient,
		buildExecuteCode,
		interpretExecute,
	}
})
