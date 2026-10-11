const {describe, it} = require("node:test")
const assert = require("node:assert/strict")
const zlib = require("node:zlib")
const lib = require("../lib.js")

describe("parseToken", () => {
	const token = "vk1.a.AbC_d-E123456789012345678901234567890"

	it("reads the token from oauth.vk.ru and oauth.vk.com redirects", () => {
		for (const host of ["oauth.vk.ru", "oauth.vk.com"]) {
			const result = lib.parseToken(`https://${host}/blank.html#access_token=${token}&expires_in=86400&user_id=42`)
			assert.deepEqual(result, {token, userId: 42, expiresIn: 86400})
		}
	})

	it("does not depend on the parameter order or a trailing &", () => {
		assert.equal(lib.parseToken(`https://oauth.vk.ru/blank.html#user_id=42&access_token=${token}`).token, token)
		assert.equal(lib.parseToken(`#access_token=${token}`).token, token)
	})

	it("accepts a bare token", () => {
		assert.equal(lib.parseToken(`  ${token}  `).token, token)
	})

	it("recognizes a denied request", () => {
		const result = lib.parseToken(
			"https://oauth.vk.ru/blank.html#error=access_denied&error_reason=user_denied&error_description=User+denied+your+request"
		)
		assert.equal(result.error, "denied")
		assert.equal(result.description, "User denied your request")
	})

	it("rejects garbage", () => {
		assert.equal(lib.parseToken("").error, "empty")
		assert.equal(lib.parseToken("https://oauth.vk.ru/blank.html").error, "invalid")
		assert.equal(lib.parseToken("hello world").error, "invalid")
	})
})

describe("extractCommentLinks", () => {
	it("finds links on any vk domain", () => {
		const html = `
			<a href="https://vk.com/wall-1_2?reply=3">a</a>
			<a href="https://vk.ru/wall5_6?reply=7">b</a>
			<a href="https://m.vk.ru/wall8_9?reply=10">c</a>
			<a href="http://vkontakte.ru/wall11_12?reply=13">d</a>
			<a href="/wall14_15?reply=16">e</a>`
		assert.deepEqual(
			lib.extractCommentLinks(html).map(link => [link.ownerId, link.postId, link.reply]),
			[
				[-1, 2, 3],
				[5, 6, 7],
				[8, 9, 10],
				[11, 12, 13],
				[14, 15, 16],
			]
		)
	})

	it("reads thread from escaped and plain urls in any order", () => {
		const html = `
			<a href="https://vk.ru/wall-1_2?reply=30&amp;thread=20">a</a>
			<a href="https://vk.ru/wall-1_2?thread=20&reply=31">b</a>`
		assert.deepEqual(
			lib.extractCommentLinks(html).map(link => [link.reply, link.thread]),
			[
				[30, 20],
				[31, 20],
			]
		)
	})

	it("skips links to posts and drops thread equal to reply", () => {
		const links = lib.extractCommentLinks(`
			<a href="https://vk.ru/wall-1_2">post</a>
			<a href="https://vk.ru/wall-1_2?w=wall-1_2">post</a>
			<a href="https://vk.ru/wall-1_2?reply=5&thread=5">c</a>`)
		assert.equal(links.length, 1)
		assert.equal(links[0].thread, null)
	})

	it("detects other comment types", () => {
		const types = lib
			.extractCommentLinks(
				`https://vk.ru/photo1_2?reply=3 https://vk.ru/video-1_2?reply=3 https://vk.ru/market-1_2?reply=3`
			)
			.map(link => link.type)
		assert.deepEqual(types, ["photo", "video", "market"])
	})
})

describe("isCommentsPath", () => {
	it("accepts html files inside a comments folder", () => {
		assert.ok(lib.isCommentsPath("comments/comments.html"))
		assert.ok(lib.isCommentsPath("Archive/comments/comments50.html"))
		assert.ok(lib.isCommentsPath("Archive\\comments\\comments50.html"))
	})

	it("rejects other sections and junk", () => {
		assert.ok(!lib.isCommentsPath("likes/comments.html"))
		assert.ok(!lib.isCommentsPath("comments.html"))
		assert.ok(!lib.isCommentsPath("comments/style.css"))
		assert.ok(!lib.isCommentsPath("__MACOSX/comments/._comments.html"))
	})
})

describe("buildQueue", () => {
	it("dedupes and separates unsupported types", () => {
		const links = lib.extractCommentLinks(`
			https://vk.com/wall-1_2?reply=3
			https://vk.ru/wall-1_2?reply=3
			https://vk.ru/wall-1_2?reply=4&thread=3
			https://vk.ru/photo1_2?reply=3`)
		const result = lib.buildQueue(links)
		assert.equal(result.total, 4)
		assert.equal(result.duplicates, 1)
		assert.equal(result.queue.length, 2)
		assert.deepEqual(result.unsupported, {photo: 1})
		assert.equal(lib.commentUrl(result.queue[1]), "https://vk.ru/wall-1_2?reply=4&thread=3")
	})

	it("hashes the same set of keys equally regardless of order", () => {
		assert.equal(lib.hashKeys(["a", "b"]), lib.hashKeys(["b", "a"]))
		assert.notEqual(lib.hashKeys(["a", "b"]), lib.hashKeys(["a", "c"]))
	})
})

describe("extractArchiveOwner", () => {
	// vk writes unpadded base64 json into the jd meta tag
	const jd = data => Buffer.from(JSON.stringify(data)).toString("base64").replace(/=+$/, "")

	it("reads the account id from the archive page", () => {
		const html = `<head><meta charset="windows-1251">
			<meta name="jd" content="${jd({user_id: 42, time_current: 1790000000})}"></head>`
		assert.equal(lib.extractArchiveOwner(html), 42)
	})

	it("does not depend on the attribute order or the base64 flavour", () => {
		const content = jd({user_id: 1234567, note: "??>>"}).replace(/\+/g, "-").replace(/\//g, "_")
		assert.equal(lib.extractArchiveOwner(`<meta content='${content}' name='jd'>`), 1234567)
	})

	it("returns null when there is nothing to read", () => {
		assert.equal(lib.extractArchiveOwner("<a href='https://vk.ru/wall1_2?reply=3'>"), null)
		assert.equal(lib.extractArchiveOwner(`<meta name="jd" content="not base64!">`), null)
		assert.equal(lib.extractArchiveOwner(`<meta name="jd" content="${jd({foo: 1})}">`), null)
	})
})

// minimal zip writer for tests
const makeZip = files => {
	const locals = []
	const centrals = []
	let offset = 0
	for (const {name, content, store} of files) {
		const nameBuffer = Buffer.from(name)
		const raw = Buffer.from(content)
		const data = store ? raw : zlib.deflateRawSync(raw)
		const method = store ? 0 : 8
		const crc = zlib.crc32(raw)
		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4)
		local.writeUInt16LE(method, 8)
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(data.length, 18)
		local.writeUInt32LE(raw.length, 22)
		local.writeUInt16LE(nameBuffer.length, 26)
		const central = Buffer.alloc(46)
		central.writeUInt32LE(0x02014b50, 0)
		central.writeUInt16LE(20, 4)
		central.writeUInt16LE(20, 6)
		central.writeUInt16LE(method, 10)
		central.writeUInt32LE(crc, 16)
		central.writeUInt32LE(data.length, 20)
		central.writeUInt32LE(raw.length, 24)
		central.writeUInt16LE(nameBuffer.length, 28)
		central.writeUInt32LE(offset, 42)
		locals.push(local, nameBuffer, data)
		centrals.push(central, nameBuffer)
		offset += 30 + nameBuffer.length + data.length
	}
	const dir = Buffer.concat(centrals)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(files.length, 8)
	end.writeUInt16LE(files.length, 10)
	end.writeUInt32LE(dir.length, 12)
	end.writeUInt32LE(offset, 16)
	return new Blob([Buffer.concat([...locals, dir, end])])
}

describe("zip", () => {
	it("lists and reads stored and deflated entries", async () => {
		const html = `<a href="https://vk.ru/wall-1_2?reply=3">x</a>`.repeat(50)
		const blob = makeZip([
			{name: "Archive/comments/comments.html", content: html},
			{name: "Archive/comments/comments50.html", content: "stored", store: true},
			{name: "Archive/likes/likes.html", content: "nope"},
		])
		const entries = await lib.listZip(blob)
		assert.deepEqual(
			entries.map(entry => entry.name),
			["Archive/comments/comments.html", "Archive/comments/comments50.html", "Archive/likes/likes.html"]
		)
		const decoder = new TextDecoder()
		assert.equal(decoder.decode(await lib.readZipEntry(blob, entries[0])), html)
		assert.equal(decoder.decode(await lib.readZipEntry(blob, entries[1])), "stored")
		assert.deepEqual(
			entries.filter(entry => lib.isCommentsPath(entry.name)).map(entry => entry.name),
			["Archive/comments/comments.html", "Archive/comments/comments50.html"]
		)
	})

	it("rejects non-zip files", async () => {
		await assert.rejects(lib.listZip(new Blob(["just text"])), lib.ZipError)
	})
})

describe("classifyError", () => {
	it("maps vk error codes", () => {
		assert.equal(lib.classifyError(6), "slowdown")
		assert.equal(lib.classifyError(9), "flood")
		assert.equal(lib.classifyError(10), "retry")
		assert.equal(lib.classifyError(29), "quota")
		assert.equal(lib.classifyError(5), "auth")
		assert.equal(lib.classifyError(14), "captcha")
		assert.equal(lib.classifyError(211), "skip")
		assert.equal(lib.classifyError(999), "unknown")
		assert.ok(lib.isTransient("flood"))
		assert.ok(!lib.isTransient("skip"))
	})
})

// runs the generated vkscript as javascript against a fake api, the way vk's execute would
const runExecute = (code, world) => {
	const errors = []
	let calls = 0
	const fail = (method, code) => {
		errors.push({method, error_code: code, error_msg: `error ${code}`})
		return false
	}
	const API = {
		wall: {
			getComment: ({owner_id, comment_id}) => {
				calls++
				const item = world.comments[`${owner_id}_${comment_id}`]
				if (item === undefined) return {items: []}
				if (typeof item === "number") return fail("wall.getComment", item)
				return {items: [item]}
			},
			deleteComment: ({owner_id, comment_id}) => {
				calls++
				const code = (world.deleteErrors || {})[`${owner_id}_${comment_id}`]
				if (code) return fail("wall.deleteComment", code)
				world.deleted.push(`${owner_id}_${comment_id}`)
				return 1
			},
		},
	}
	const response = new Function("API", code)(API)
	assert.ok(calls <= 25, `too many api calls in one execute: ${calls}`)
	return errors.length ? {response, execute_errors: errors} : {response}
}

describe("execute", () => {
	const me = 100
	const comment = (reply, thread = null) => ({ownerId: -1, postId: 1, reply, thread})

	const run = (batch, world, dryRun = false) => {
		world.deleted = []
		const data = runExecute(lib.buildExecuteCode(batch, me, dryRun), world)
		return lib.interpretExecute(batch, data, me, dryRun)
	}

	it("deletes own comments and skips others", () => {
		const world = {comments: {"-1_10": {from_id: me}, "-1_11": {from_id: 555}}}
		const result = run([comment(10), comment(11)], world)
		assert.deepEqual(
			result.map(r => r.status),
			["deleted", "notMine"]
		)
		assert.deepEqual(world.deleted, ["-1_10"])
	})

	it("falls back to thread only when reply is not the user's", () => {
		const world = {comments: {"-1_30": {from_id: 555}, "-1_20": {from_id: me}}}
		const result = run([comment(30, 20)], world)
		assert.equal(result[0].status, "deleted")
		assert.equal(result[0].matched, "thread")
		assert.deepEqual(world.deleted, ["-1_20"])
	})

	it("prefers reply when both belong to the user", () => {
		const world = {comments: {"-1_30": {from_id: me}, "-1_20": {from_id: me}}}
		const result = run([comment(30, 20)], world)
		assert.equal(result[0].matched, "reply")
		assert.deepEqual(world.deleted, ["-1_30"])
	})

	it("reports gone comments and maps errors in order", () => {
		const world = {comments: {"-1_1": 15, "-1_3": {from_id: me}, "-1_4": 211}}
		const result = run([comment(1), comment(2), comment(3), comment(4)], world)
		assert.deepEqual(
			result.map(r => r.status),
			["gone", "gone", "deleted", "gone"]
		)
		assert.equal(result[0].error.code, 15)
		assert.equal(result[3].error.code, 211)
	})

	it("reports unexpected errors as failures, not as gone", () => {
		const world = {comments: {"-1_1": 999, "-1_2": 15}}
		const result = run([comment(1), comment(2)], world)
		assert.deepEqual(
			result.map(r => [r.status, r.error.code]),
			[
				["failed", 999],
				["gone", 15],
			]
		)
	})

	it("marks throttled deletes for retry", () => {
		const world = {
			comments: {"-1_1": {from_id: me}, "-1_2": {from_id: me}, "-1_3": 6},
			deleteErrors: {"-1_1": 9},
		}
		const result = run([comment(1), comment(2), comment(3)], world)
		assert.deepEqual(
			result.map(r => [r.status, r.kind]),
			[
				["retry", "flood"],
				["deleted", undefined],
				["retry", "slowdown"],
			]
		)
	})

	it("does not delete anything in dry run", () => {
		const world = {comments: {"-1_1": {from_id: me}, "-1_2": {from_id: 555}}}
		const result = run([comment(1), comment(2)], world, true)
		assert.deepEqual(
			result.map(r => r.status),
			["wouldDelete", "notMine"]
		)
		assert.deepEqual(world.deleted, [])
	})

	it("stays within 25 calls for a full batch in the worst case", () => {
		const batch = Array.from({length: 8}, (_, i) => comment(100 + i, 200 + i))
		const comments = {}
		batch.forEach(c => {
			comments[`-1_${c.reply}`] = {from_id: 555}
			comments[`-1_${c.thread}`] = {from_id: me}
		})
		const result = run(batch, {comments})
		assert.ok(result.every(r => r.status === "deleted"))
	})
})
