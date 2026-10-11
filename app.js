;(() => {
	"use strict"

	const {
		parseToken,
		extractCommentLinks,
		isCommentsPath,
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
	} = window.VKRC

	// ---------- settings ----------

	// donation details: empty values are not shown on the page
	const DONATE = {
		tribute: "https://web.tribute.tg/d/RYO",
		sbp: "", //t-bank payment link (preferred) or a phone number
		ton: "UQBz6VlQYGfhtPwGiXr9bCLwId1zXuKlXMnxQAwle4OJ_aRZ",
		usdt: "TKbaj16cKAKbnWAW6MAXieGGPYCgj7QTqN",
		usdtNetwork: "TRC-20",
		btc: "bc1qxd0hqr74kh6jq8t3qjuxe5893h7p8dlu3ye7el",
	}

	// apps that still accept a wall-only token request on oauth.vk.ru (checked in october 2026)
	const AUTH_APPS = [
		{id: 4083558, name: "VFeed"},
		{id: 3698024, name: "Instagram"},
		{id: 5530956, name: "Prisma"},
	]
	const WALL_SCOPE = 8192
	const API_HOSTS = ["api.vk.ru", "api.vk.com"]
	const API_VERSION = "5.199"
	const REQUEST_INTERVAL = 400 //vk allows 3 requests per second for user tokens
	const REQUEST_TIMEOUT = 30000
	const BATCH_SIZE = 8
	const MAX_ATTEMPTS = 3
	const FLOOD_PAUSES = [30, 60, 120] //seconds
	const NETWORK_PAUSES = [3, 10, 30] //seconds
	const STORAGE_PREFIX = "vkrc:progress:"
	const ORIGINAL_TITLE = document.title

	const STATUS_LABELS = {
		deleted: "Удалено",
		wouldDelete: "Можно удалить",
		gone: "Уже нет или нет доступа",
		notMine: "Не ваши, пропущены",
		failed: "Ошибки",
	}
	// the worst problem in a batch decides what to do next
	const SEVERITY = {slowdown: 1, retry: 2, flood: 3, captcha: 4, validation: 5, auth: 6, quota: 7}
	// these problems do not count as failed attempts: the comment is simply tried again later
	const PATIENT_KINDS = ["flood", "captcha", "validation", "auth", "quota"]

	// ---------- helpers ----------

	const $ = id => document.getElementById(id)

	const el = (tag, props = {}, children = []) => {
		const node = document.createElement(tag)
		Object.entries(props).forEach(([key, value]) => {
			if (key === "class") node.className = value
			else if (key === "text") node.textContent = value
			else if (key.startsWith("on")) node.addEventListener(key.slice(2), value)
			else node.setAttribute(key, value)
		})
		;[].concat(children).forEach(child => child != null && node.append(child))
		return node
	}

	const plural = (n, forms) => {
		const tens = Math.abs(n) % 100
		const units = tens % 10
		if (tens > 10 && tens < 20) return forms[2]
		if (units > 1 && units < 5) return forms[1]
		if (units === 1) return forms[0]
		return forms[2]
	}
	const COMMENTS = ["комментарий", "комментария", "комментариев"]

	const formatNumber = n => n.toLocaleString("ru-RU")

	const formatDuration = seconds => {
		if (seconds < 60) return "меньше минуты"
		const minutes = Math.round(seconds / 60)
		if (minutes < 60) return `${minutes} мин`
		return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
	}

	const setStatus = (node, type, content) => {
		node.hidden = false
		node.className = `status ${type}`.trim()
		node.replaceChildren(...[].concat(content).map(item => (typeof item === "string" ? el("p", {text: item}) : item)))
	}

	const decoder = new TextDecoder()

	// timers in a worker are not slowed down as much as page timers when the tab is in the background
	const sleep = (() => {
		const fallback = ms => new Promise(resolve => setTimeout(resolve, ms))
		try {
			const source = "onmessage = e => setTimeout(() => postMessage(e.data.id), e.data.ms)"
			const worker = new Worker(URL.createObjectURL(new Blob([source], {type: "text/javascript"})))
			const waiting = new Map()
			let broken = false
			let sequence = 0
			worker.onmessage = event => {
				const timer = waiting.get(event.data)
				waiting.delete(event.data)
				if (timer) timer.resolve()
			}
			worker.onerror = () => {
				broken = true
				waiting.forEach(timer => fallback(timer.ms).then(timer.resolve))
				waiting.clear()
			}
			return ms => {
				if (broken) return fallback(ms)
				return new Promise(resolve => {
					const id = sequence++
					waiting.set(id, {resolve, ms})
					worker.postMessage({id, ms})
				})
			}
		} catch (e) {
			return fallback
		}
	})()

	const storage = {
		load: key => {
			try {
				return JSON.parse(localStorage.getItem(STORAGE_PREFIX + key))
			} catch (e) {
				return null
			}
		},
		save: (key, value) => {
			try {
				localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value))
			} catch (e) {
				//private mode or full storage: progress just won't survive a reload
			}
		},
		remove: key => {
			try {
				localStorage.removeItem(STORAGE_PREFIX + key)
			} catch (e) {}
		},
	}

	// ---------- vk api ----------

	class ApiError extends Error {
		constructor(error) {
			super(error.error_msg || "Ошибка API ВК")
			this.code = error.error_code
			this.raw = error
		}
	}

	class NetworkError extends Error {}

	// vk api has no cors, but supports jsonp
	let callbackSequence = 0
	const jsonp = url =>
		new Promise((resolve, reject) => {
			const name = `vkrc_${Date.now().toString(36)}_${callbackSequence++}`
			const script = document.createElement("script")
			let timer = null
			const cleanup = () => {
				clearTimeout(timer)
				script.remove()
				window[name] = () => {} //a late response must not throw
				setTimeout(() => delete window[name], 60000)
			}
			window[name] = data => {
				cleanup()
				resolve(data)
			}
			script.onerror = () => {
				cleanup()
				reject(new NetworkError("Нет ответа от ВК"))
			}
			timer = setTimeout(() => {
				cleanup()
				reject(new NetworkError("ВК не ответил вовремя"))
			}, REQUEST_TIMEOUT)
			script.src = `${url}&callback=${name}`
			document.head.append(script)
		})

	let hostIndex = 0
	let lastRequestAt = 0

	const callApi = async (method, params = {}) => {
		const wait = lastRequestAt + REQUEST_INTERVAL - Date.now()
		if (wait > 0) await sleep(wait)

		const query = {...params, access_token: state.token, v: API_VERSION}
		if (state.captchaAnswer) {
			Object.assign(query, state.captchaAnswer)
			state.captchaAnswer = null
		}
		const search = new URLSearchParams(query).toString()

		let networkError = null
		for (let attempt = 0; attempt < API_HOSTS.length; attempt++) {
			const index = (hostIndex + attempt) % API_HOSTS.length
			lastRequestAt = Date.now()
			try {
				const data = await jsonp(`https://${API_HOSTS[index]}/method/${method}?${search}`)
				hostIndex = index
				if (data && data.error) throw new ApiError(data.error)
				return data
			} catch (error) {
				if (!(error instanceof NetworkError)) throw error
				networkError = error
			}
		}
		throw networkError
	}

	// ---------- state ----------

	const state = {
		links: [],
		files: 0,
		problems: [],
		queue: [],
		unsupported: {},
		duplicates: 0,
		queueHash: null,
		saved: new Map(), //results of earlier delete runs over the same queue
		token: null,
		user: null,
		tokenExpiresIn: null,
		captchaAnswer: null,
		mode: "execute",
		singleLeft: 0,
		batchSize: BATCH_SIZE,
		running: false,
		paused: false,
		stopRequested: false,
		run: null,
	}

	// ---------- step 1: archive ----------

	const archiveStatus = $("archive-status")
	const dropzone = $("dropzone")
	const fileInput = $("file-input")
	const folderInput = $("folder-input")

	const rebuildQueue = () => {
		const {queue, unsupported, duplicates} = buildQueue(state.links)
		Object.assign(state, {queue, unsupported, duplicates})
		state.queueHash = queue.length ? hashKeys(queue.map(comment => comment.key)) : null
		const saved = state.queueHash ? storage.load(state.queueHash) : null
		state.saved = new Map(
			((saved && saved.results) || []).map(([key, status, error]) => [key, {status, error}])
		)
		$("progress").hidden = true
		$("step-done").hidden = true
		renderArchiveStatus()
		renderRunState()
	}

	const renderArchiveStatus = () => {
		if (!state.links.length && !state.problems.length) {
			archiveStatus.hidden = true
			return
		}
		const clear = el("button", {type: "button", class: "btn small ghost", text: "Очистить", onclick: clearArchive})
		const problems = state.problems.map(text => el("p", {text}))
		if (!state.queue.length) {
			const empty = state.links.length
				? "Нашлись только комментарии к фото, видео или товарам: их пока не удаляем."
				: "Ссылок на комментарии не нашлось."
			setStatus(archiveStatus, "error", [empty, ...problems, el("div", {class: "row"}, clear)])
			return
		}
		const otherTotal = Object.values(state.unsupported).reduce((sum, n) => sum + n, 0)
		const details = [
			state.files ? `Прочитано файлов: ${formatNumber(state.files)}` : null,
			`ссылок: ${formatNumber(state.links.length)}`,
			state.duplicates ? `повторов: ${formatNumber(state.duplicates)}` : null,
		]
			.filter(Boolean)
			.join(" · ")
		setStatus(archiveStatus, state.problems.length ? "warn" : "ok", [
			el("p", {}, el("b", {text: `Найдено ${formatNumber(state.queue.length)} ${plural(state.queue.length, COMMENTS)} на стенах`})),
			details,
			otherTotal
				? `Ещё ${formatNumber(otherTotal)} ${plural(otherTotal, COMMENTS)} к фото, видео или товарам: их пока не удаляем.`
				: null,
			...problems,
			el("div", {class: "row"}, clear),
		].filter(Boolean))
	}

	const clearArchive = () => {
		if (state.running) return
		Object.assign(state, {links: [], files: 0, problems: []})
		rebuildQueue()
	}

	const readSources = async sources => {
		if (state.running) return
		setStatus(archiveStatus, "", "Читаю файлы…")
		const links = []
		const problems = []
		let read = 0
		for (const {file, path, fromFolder} of sources) {
			const name = file.name.toLowerCase()
			try {
				if (name.endsWith(".zip")) {
					const entries = (await listZip(file)).filter(entry => isCommentsPath(entry.name))
					if (!entries.length) {
						problems.push(
							`В архиве ${file.name} нет папки comments. При запросе архива нужно отметить «Комментарии».`
						)
						continue
					}
					for (const entry of entries) {
						links.push(...extractCommentLinks(decoder.decode(await readZipEntry(file, entry))))
						read++
					}
				} else if (/\.html?$/.test(name)) {
					if (fromFolder && !isCommentsPath(path)) continue //likes and other sections link to other people's comments
					links.push(...extractCommentLinks(await file.text()))
					read++
				}
			} catch (error) {
				problems.push(error instanceof ZipError ? `${file.name}: ${error.message}` : `Не удалось прочитать ${file.name}`)
			}
		}
		if (!read && !problems.length) {
			problems.push("Подходящих файлов не нашлось. Нужен zip-архив ВК, его папка comments или html-файлы из неё.")
		}
		state.links.push(...links)
		state.files += read
		state.problems = problems
		rebuildQueue()
	}

	// a dropped folder is walked recursively, keeping paths to tell the comments folder from the others
	const collectDropped = dataTransfer => {
		const entries = [...dataTransfer.items]
			.map(item => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
			.filter(Boolean)
		if (!entries.length) {
			return Promise.resolve([...dataTransfer.files].map(file => ({file, path: file.name, fromFolder: false})))
		}
		const sources = []
		const walk = async (entry, fromFolder) => {
			if (entry.isFile) {
				const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
				sources.push({file, path: entry.fullPath.replace(/^\//, ""), fromFolder})
			} else if (entry.isDirectory) {
				const reader = entry.createReader()
				let batch
				do {
					batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
					for (const child of batch) await walk(child, true)
				} while (batch.length)
			}
		}
		return entries.reduce((chain, entry) => chain.then(() => walk(entry, entry.isDirectory)), Promise.resolve()).then(
			() => sources
		)
	}

	dropzone.addEventListener("click", event => {
		if (!event.target.closest("button")) fileInput.click()
	})
	dropzone.addEventListener("keydown", event => {
		if (event.target === dropzone && (event.key === "Enter" || event.key === " ")) {
			event.preventDefault()
			fileInput.click()
		}
	})
	$("pick-files").addEventListener("click", () => fileInput.click())
	$("pick-folder").addEventListener("click", () => folderInput.click())
	;["dragenter", "dragover"].forEach(type =>
		dropzone.addEventListener(type, event => {
			event.preventDefault()
			dropzone.classList.add("over")
		})
	)
	;["dragleave", "drop"].forEach(type => dropzone.addEventListener(type, () => dropzone.classList.remove("over")))
	dropzone.addEventListener("drop", event => {
		event.preventDefault()
		collectDropped(event.dataTransfer).then(readSources)
	})
	//dropping a file outside the zone must not navigate away from the page
	window.addEventListener("dragover", event => event.preventDefault())
	window.addEventListener("drop", event => event.preventDefault())

	fileInput.addEventListener("change", () => {
		readSources([...fileInput.files].map(file => ({file, path: file.name, fromFolder: false})))
		fileInput.value = ""
	})
	folderInput.addEventListener("change", () => {
		readSources([...folderInput.files].map(file => ({file, path: file.webkitRelativePath || file.name, fromFolder: true})))
		folderInput.value = ""
	})

	$("manual-add").addEventListener("click", () => {
		if (state.running) return
		const textarea = $("manual-links")
		const links = extractCommentLinks(textarea.value)
		if (!links.length) {
			state.problems = ["В тексте не нашлось ссылок на комментарии. Они выглядят так: https://vk.ru/wall-1_2?reply=3"]
			renderArchiveStatus()
			return
		}
		textarea.value = ""
		state.links.push(...links)
		state.problems = []
		rebuildQueue()
	})

	// ---------- step 2: token ----------

	const tokenInput = $("token-input")
	const tokenStatus = $("token-status")

	const authUrl = appId =>
		`https://oauth.vk.ru/authorize?${new URLSearchParams({
			client_id: appId,
			scope: WALL_SCOPE,
			redirect_uri: "https://oauth.vk.ru/blank.html",
			display: "page",
			response_type: "token",
			revoke: 1,
		})}`

	$("auth-main").href = authUrl(AUTH_APPS[0].id)
	$("auth-fallbacks").append(
		...AUTH_APPS.slice(1).map(app =>
			el("a", {
				class: "btn small ghost",
				href: authUrl(app.id),
				target: "_blank",
				rel: "noopener noreferrer",
				text: app.name,
			})
		)
	)

	const resetToken = () => {
		Object.assign(state, {token: null, user: null, tokenExpiresIn: null})
		$("token-field").hidden = false
		tokenStatus.hidden = true
		renderRunState()
	}

	const renderUser = () => {
		const {user, tokenExpiresIn} = state
		const avatar = user.photo_100 ? el("img", {src: user.photo_100, alt: ""}) : null
		if (avatar) avatar.addEventListener("error", () => avatar.remove())
		const hours = tokenExpiresIn ? Math.round(tokenExpiresIn / 3600) : 0
		$("token-field").hidden = true
		setStatus(
			tokenStatus,
			"ok",
			el("div", {class: "user"}, [
				avatar,
				el("div", {class: "grow"}, [
					el("p", {}, ["Вы вошли как ", el("b", {text: `${user.first_name} ${user.last_name}`})]),
					el("p", {
						class: "hint",
						text: hours ? `Доступ к стене получен и истечёт сам примерно через ${hours} ч.` : "Доступ к стене получен.",
					}),
				]),
				el("button", {type: "button", class: "btn small ghost", text: "Сменить", onclick: resetToken}),
			])
		)
	}

	const checkToken = async () => {
		if (state.running) return
		const parsed = parseToken(tokenInput.value)
		if (parsed.error === "empty") return
		if (parsed.error === "denied") {
			setStatus(tokenStatus, "error", "В ВК нажали «Отмена». Нажмите кнопку ещё раз и выберите «Разрешить».")
			return
		}
		if (parsed.error) {
			setStatus(
				tokenStatus,
				"error",
				"Не вижу токена. Скопируйте адрес страницы целиком: он начинается с https://oauth.vk.ru/blank.html#access_token="
			)
			return
		}
		tokenInput.value = "" //the token should not stay on screen
		state.token = parsed.token
		setStatus(tokenStatus, "", "Проверяю доступ…")
		try {
			const data = await callApi("users.get", {fields: "photo_100"})
			const user = data.response && data.response[0]
			if (!user) throw new ApiError({error_code: 5, error_msg: "это не токен пользователя"})
			state.user = user
			state.tokenExpiresIn = parsed.expiresIn
			renderUser()
		} catch (error) {
			Object.assign(state, {token: null, user: null})
			if (error instanceof ApiError && error.code === 5) {
				setStatus(tokenStatus, "error", "ВК не принял токен: он истёк или скопирован не полностью. Получите новый.")
			} else if (error instanceof ApiError) {
				setStatus(tokenStatus, "error", `ВК ответил ошибкой: ${error.message}`)
			} else {
				setStatus(
					tokenStatus,
					"error",
					"Не удалось связаться с ВК. Проверьте интернет и отключите программы обхода блокировок, если они есть."
				)
			}
		}
		renderRunState()
	}

	$("token-check").addEventListener("click", checkToken)
	tokenInput.addEventListener("paste", () => setTimeout(checkToken, 0))
	tokenInput.addEventListener("keydown", event => {
		if (event.key === "Enter") checkToken()
	})

	// ---------- step 3: deleting ----------

	const dryRunButton = $("dry-run")
	const startButton = $("start")
	const pauseButton = $("pause")
	const stopButton = $("stop")
	const runMessage = $("run-message")
	const logList = $("log")

	const log = (text, type = "") => {
		logList.prepend(el("li", {class: type}, [el("time", {text: new Date().toLocaleTimeString("ru-RU")}), text]))
		while (logList.children.length > 300) logList.lastChild.remove()
	}

	const pendingCount = () => state.queue.filter(comment => !state.saved.has(comment.key)).length

	const renderRunState = () => {
		const ready = state.queue.length > 0 && !!state.user
		const left = pendingCount()
		dryRunButton.disabled = !ready || state.running
		startButton.disabled = !ready || state.running || left === 0
		startButton.textContent = state.saved.size && left ? "Продолжить удаление" : "Удалить комментарии"
		pauseButton.hidden = stopButton.hidden = !state.running

		const hint = $("run-hint")
		hint.hidden = state.running || (ready && left === 0)
		if (!state.queue.length) hint.textContent = "Загрузите архив на шаге 1."
		else if (!state.user) hint.textContent = "Получите доступ на шаге 2."
		else {
			hint.textContent = `К удалению: ${formatNumber(left)} ${plural(left, COMMENTS)}. Можно сначала проверить без удаления: страница посчитает, сколько из них ещё существуют и точно ваши.`
		}

		const resume = $("resume")
		resume.hidden = state.running || !state.saved.size
		$("resume-text").textContent = left
			? `Вы уже удаляли комментарии из этого архива: обработано ${formatNumber(state.saved.size)} из ${formatNumber(state.queue.length)}. Удаление продолжится с места остановки.`
			: "Все комментарии из этого архива уже обработаны."
	}

	$("resume-reset").addEventListener("click", () => {
		if (state.running || !state.queueHash) return
		storage.remove(state.queueHash)
		state.saved = new Map()
		renderRunState()
	})

	const showMessage = (type, text) => setStatus(runMessage, type, text)
	const hideMessage = () => (runMessage.hidden = true)

	const renderProgress = () => {
		const {results, total, dryRun, startedAt, startedWith} = state.run
		const done = results.size
		const percent = total ? Math.floor((done / total) * 100) : 100
		$("bar-fill").style.width = `${percent}%`
		$("bar").setAttribute("aria-valuenow", percent)
		$("progress-text").textContent = `${formatNumber(done)} из ${formatNumber(total)}`
		const processedNow = done - startedWith
		const elapsed = (Date.now() - startedAt) / 1000
		$("eta").textContent =
			state.running && processedNow > 0 && done < total
				? `осталось ${formatDuration((elapsed / processedNow) * (total - done))}`
				: ""

		const counts = {deleted: 0, wouldDelete: 0, gone: 0, notMine: 0, failed: 0}
		results.forEach(result => counts[result.status]++)
		const shown = [dryRun ? "wouldDelete" : "deleted", "gone", "notMine", "failed"]
		$("counters").replaceChildren(
			...shown.map(status =>
				el("div", {class: status === "failed" ? "error" : ["deleted", "wouldDelete"].includes(status) ? "ok" : ""}, [
					el("dt", {text: STATUS_LABELS[status]}),
					el("dd", {text: formatNumber(counts[status])}),
				])
			)
		)
		if (state.running) document.title = `${percent}% · ${ORIGINAL_TITLE}`
		return counts
	}

	const saveProgress = () => {
		if (state.run.dryRun) return
		storage.save(state.queueHash, {
			results: [...state.run.results].map(([key, result]) => [key, result.status, result.error]),
		})
	}

	const record = (comment, outcome) => {
		const error = outcome.error
		const errorText = error ? `${error.code ? `${error.code}: ` : ""}${error.message}` : ""
		state.run.results.set(comment.key, {status: outcome.status, error: errorText})
		const url = commentUrl(comment)
		if (outcome.matched === "thread") log(`Найден по thread, а не по reply: ${url}`, "warn")
		if (outcome.status === "notMine") log(`Не ваш, пропущен: ${url}`, "warn")
		if (outcome.status === "failed") log(`Не удалось удалить ${url}: ${errorText}`, "error")
		if (outcome.status === "gone" && errorText) log(`Нет доступа к ${url}: ${errorText}`)
	}

	// pause / resume / stop

	let resumeWaiter = null
	let captchaWaiter = null

	const waitForResume = () => new Promise(resolve => (resumeWaiter = resolve))

	const wake = () => {
		if (resumeWaiter) resumeWaiter()
		if (captchaWaiter) captchaWaiter()
		resumeWaiter = captchaWaiter = null
	}

	const pauseWith = (type, text) => {
		state.paused = true
		pauseButton.textContent = "Продолжить"
		showMessage(type, text)
		log(text, type)
	}

	pauseButton.addEventListener("click", () => {
		if (state.paused) {
			state.paused = false
			pauseButton.textContent = "Пауза"
			hideMessage()
			wake()
		} else pauseWith("", "Пауза. Нажмите «Продолжить», когда будете готовы.")
	})

	stopButton.addEventListener("click", () => {
		state.stopRequested = true
		showMessage("", "Останавливаю…")
		wake()
	})

	// a pause or a stop ends the countdown early
	const countdown = async (seconds, text) => {
		for (let left = seconds; left > 0; left--) {
			if (state.stopRequested || state.paused) return
			showMessage("warn", text(left))
			await sleep(1000)
		}
		hideMessage()
	}

	const solveCaptcha = async error => {
		const raw = error instanceof ApiError ? error.raw : null
		if (!raw) {
			//captcha inside a batch: the next comments go one by one, so vk can show it to us directly
			state.singleLeft = state.batchSize
			return
		}
		if (!raw.captcha_img && !raw.redirect_uri) {
			pauseWith("warn", "ВК просит пройти проверку. Откройте vk.ru в этом браузере, пройдите её и нажмите «Продолжить».")
			return
		}
		const box = $("captcha")
		const image = $("captcha-img")
		const input = $("captcha-input")
		image.hidden = input.hidden = !raw.captcha_img
		if (raw.captcha_img) image.src = raw.captcha_img
		$("captcha-link").hidden = !raw.redirect_uri
		if (raw.redirect_uri) $("captcha-link").href = raw.redirect_uri
		$("captcha-send").textContent = raw.captcha_img ? "Продолжить" : "Я прошёл проверку"
		input.value = ""
		box.hidden = false
		log("ВК попросил капчу", "warn")
		if (raw.captcha_img) input.focus()
		await new Promise(resolve => (captchaWaiter = resolve))
		box.hidden = true
		if (raw.captcha_sid && input.value.trim()) {
			state.captchaAnswer = {captcha_sid: raw.captcha_sid, captcha_key: input.value.trim()}
		}
	}

	$("captcha-send").addEventListener("click", wake)
	$("captcha-input").addEventListener("keydown", event => {
		if (event.key === "Enter") wake()
	})

	// returns false when the run has to stop
	const handleTransient = async ({kind, error}) => {
		const run = state.run
		if (kind !== "flood") run.floodStreak = 0
		if (kind === "slowdown") await sleep(1500)
		else if (kind === "retry") await sleep(3000)
		else if (kind === "flood") {
			if (run.floodStreak >= FLOOD_PAUSES.length) {
				run.floodStreak = 0
				pauseWith("warn", "ВК временно ограничил удаление. Подождите 10–15 минут и нажмите «Продолжить».")
				return true
			}
			const seconds = FLOOD_PAUSES[run.floodStreak++]
			state.batchSize = Math.max(2, Math.floor(state.batchSize / 2))
			log(`ВК просит не торопиться, пауза ${seconds} с`, "warn")
			await countdown(seconds, left => `ВК просит не торопиться. Продолжу через ${left} с…`)
		} else if (kind === "captcha") await solveCaptcha(error)
		else return false //quota, auth, validation
		return true
	}

	const processBatch = async (batch, dryRun) => {
		const data = await callApi("execute", {code: buildExecuteCode(batch, state.user.id, dryRun)})
		return interpretExecute(batch, data, state.user.id, dryRun)
	}

	// same logic as the vkscript, one request at a time
	const processSingle = async (comment, dryRun) => {
		const candidates = [
			["reply", comment.reply],
			["thread", comment.thread],
		].filter(([, id]) => id)
		let sawOtherAuthor = false
		let lastError = null
		for (const [name, id] of candidates) {
			let item
			try {
				const data = await callApi("wall.getComment", {owner_id: comment.ownerId, comment_id: id})
				item = data.response && data.response.items && data.response.items[0]
			} catch (error) {
				if (!(error instanceof ApiError)) throw error
				const kind = classifyError(error.code)
				if (isTransient(kind)) return {status: "retry", kind, error}
				lastError = error
				continue
			}
			if (!item) continue
			if (item.from_id !== state.user.id) {
				sawOtherAuthor = true
				continue
			}
			if (dryRun) return {status: "wouldDelete", matched: name}
			try {
				await callApi("wall.deleteComment", {owner_id: comment.ownerId, comment_id: id})
				return {status: "deleted", matched: name}
			} catch (error) {
				if (!(error instanceof ApiError)) throw error
				const kind = classifyError(error.code)
				return {status: isTransient(kind) ? "retry" : "failed", matched: name, kind, error}
			}
		}
		if (sawOtherAuthor) return {status: "notMine"}
		return {status: "gone", error: lastError}
	}

	const processQueue = async pending => {
		const {dryRun} = state.run
		const attempts = new Map()
		let networkStreak = 0

		while (pending.length) {
			if (state.stopRequested) return {reason: "stopped"}
			if (state.paused) {
				await waitForResume()
				continue
			}

			const single = state.mode === "single" || state.singleLeft > 0
			const batch = pending.slice(0, single ? 1 : state.batchSize)
			let outcomes
			try {
				outcomes = single ? [await processSingle(batch[0], dryRun)] : await processBatch(batch, dryRun)
				if (single && state.singleLeft > 0) state.singleLeft--
				networkStreak = 0
			} catch (error) {
				if (error instanceof NetworkError) {
					if (networkStreak < NETWORK_PAUSES.length) {
						const seconds = NETWORK_PAUSES[networkStreak++]
						await countdown(seconds, left => `Нет ответа от ВК. Повтор через ${left} с…`)
					} else {
						networkStreak = 0
						pauseWith(
							"error",
							"Не получается связаться с ВК. Проверьте интернет, отключите программы обхода блокировок, если они есть, и нажмите «Продолжить»."
						)
					}
					continue
				}
				const kind = error instanceof ApiError ? classifyError(error.code) : "unknown"
				if (!single && (!isTransient(kind) || kind === "retry")) {
					//execute is not available or the script failed: fall back to one request per call
					state.mode = "single"
					log(`Пакетный режим не сработал (${error.message}), дальше по одному комментарию`, "warn")
					continue
				}
				outcomes = batch.map(() =>
					isTransient(kind) ? {status: "retry", kind, error} : {status: "failed", error: {code: 0, message: error.message}}
				)
			}

			const retry = []
			let worst = null
			outcomes.forEach((outcome, index) => {
				const comment = batch[index]
				if (outcome.status === "retry") {
					const count = (attempts.get(comment.key) || 0) + 1
					attempts.set(comment.key, count)
					if (PATIENT_KINDS.includes(outcome.kind) || count < MAX_ATTEMPTS) {
						retry.push(comment)
						if (!worst || SEVERITY[outcome.kind] > SEVERITY[worst.kind]) worst = outcome
						return
					}
					outcome = {status: "failed", error: outcome.error}
				}
				record(comment, outcome)
			})
			pending.splice(0, batch.length, ...retry)
			saveProgress()
			renderProgress()

			if (worst) {
				if (!(await handleTransient(worst))) return {reason: worst.kind, error: worst.error}
			} else state.run.floodStreak = 0
		}
		return {reason: "done"}
	}

	// keep the screen on while deleting
	let wakeLock = null
	const acquireWakeLock = async () => {
		try {
			if (navigator.wakeLock && document.visibilityState === "visible") wakeLock = await navigator.wakeLock.request("screen")
		} catch (e) {}
	}
	const releaseWakeLock = () => {
		if (wakeLock) wakeLock.release().catch(() => {})
		wakeLock = null
	}
	document.addEventListener("visibilitychange", () => {
		if (state.running && document.visibilityState === "visible") acquireWakeLock()
	})
	window.addEventListener("beforeunload", event => {
		if (!state.running) return
		event.preventDefault()
		event.returnValue = ""
	})

	const startRun = async dryRun => {
		if (state.running || !state.user) return
		const results = dryRun ? new Map() : state.saved
		const pending = state.queue.filter(comment => !results.has(comment.key))
		if (!pending.length) return
		if (
			!dryRun &&
			!window.confirm(
				`Удалить ${formatNumber(pending.length)} ${plural(pending.length, COMMENTS)}? Отменить удаление будет нельзя.`
			)
		) {
			return
		}

		Object.assign(state, {running: true, paused: false, stopRequested: false, batchSize: BATCH_SIZE, singleLeft: 0})
		state.run = {dryRun, results, total: state.queue.length, startedAt: Date.now(), startedWith: results.size, floodStreak: 0}
		pauseButton.textContent = "Пауза"
		$("progress").hidden = false
		$("step-done").hidden = true
		hideMessage()
		renderRunState()
		renderProgress()
		acquireWakeLock()
		log(
			dryRun
				? `Проверка без удаления: ${formatNumber(pending.length)} ${plural(pending.length, COMMENTS)}`
				: `Удаление: ${formatNumber(pending.length)} ${plural(pending.length, COMMENTS)}`
		)

		let result
		try {
			result = await processQueue(pending)
		} catch (error) {
			result = {reason: "crash", error}
		}

		state.running = false
		$("captcha").hidden = true
		releaseWakeLock()
		document.title = ORIGINAL_TITLE
		finishRun(result)
	}

	const finishRun = ({reason, error}) => {
		const {dryRun} = state.run
		const counts = renderProgress()
		renderRunState()

		if (reason !== "done") {
			const texts = {
				stopped: "Остановлено. Прогресс сохранён: можно продолжить в любой момент.",
				quota: "ВК исчерпал дневной лимит на удаление. Прогресс сохранён: вернитесь через несколько часов, загрузите тот же архив и нажмите «Продолжить удаление».",
				auth: "Доступ истёк или был отозван. Получите новый на шаге 2 и нажмите «Продолжить удаление».",
				validation: "ВК просит подтвердить действие в браузере. Откройте vk.ru, выполните проверку и продолжите удаление.",
				crash: `Что-то пошло не так: ${error && error.message}. Прогресс сохранён, попробуйте продолжить.`,
			}
			const text = texts[reason] || texts.crash
			showMessage(reason === "stopped" ? "" : "error", text)
			log(text, reason === "stopped" ? "" : "error")
			if (reason === "auth") resetToken()
			return
		}

		const notDeleted = counts.gone + counts.notMine + counts.failed
		$("done-title").textContent = dryRun ? "Проверка завершена" : "Готово"
		$("done-summary").textContent = dryRun
			? `Можно удалить ${formatNumber(counts.wouldDelete)} ${plural(counts.wouldDelete, COMMENTS)}. Ещё ${formatNumber(
					notDeleted
			  )} уже удалены, недоступны или принадлежат не вам. Чтобы удалить, нажмите «Удалить комментарии».`
			: `Удалено ${formatNumber(counts.deleted)} ${plural(counts.deleted, COMMENTS)}.${
					notDeleted ? ` Не удалось удалить или пропущено: ${formatNumber(notDeleted)}. Подробности в журнале и в списке ниже.` : ""
			  }`
		$("download-report").hidden = !notDeleted
		$("step-done").hidden = false
		log(dryRun ? "Проверка завершена" : "Удаление завершено", "ok")
		$("step-done").scrollIntoView({behavior: "smooth", block: "center"})
	}

	dryRunButton.addEventListener("click", () => startRun(true))
	startButton.addEventListener("click", () => startRun(false))

	$("download-report").addEventListener("click", () => {
		const {results} = state.run
		const lines = []
		state.queue.forEach(comment => {
			const result = results.get(comment.key)
			if (!result || ["deleted", "wouldDelete"].includes(result.status)) return
			lines.push([STATUS_LABELS[result.status], commentUrl(comment), result.error].filter(Boolean).join("\t"))
		})
		const text = `Комментарии, которые не удалось удалить или которые пропущены: ${lines.length}\n\n${lines.join("\n")}\n`
		const link = el("a", {
			href: URL.createObjectURL(new Blob([text], {type: "text/plain;charset=utf-8"})),
			download: "vk-comments-not-deleted.txt",
		})
		document.body.append(link)
		link.click()
		link.remove()
		setTimeout(() => URL.revokeObjectURL(link.href), 10000)
	})

	// ---------- donations ----------

	const ICONS = {
		tribute: {
			color: "#e5487c",
			svg: '<path d="M12 19.5s-7-4.3-7-9.6A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6z" fill="currentColor"/>',
		},
		sbp: {
			color: "#5b57a2",
			svg: '<path d="M5 9.5h13l-3.5-3.5M19 14.5H6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
		},
		ton: {
			color: "#0098ea",
			svg: '<path d="M6.2 6.5h11.6a1 1 0 0 1 .87 1.5L12 19.5 5.33 8a1 1 0 0 1 .87-1.5zM12 6.5v13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
		},
		usdt: {
			color: "#26a17b",
			svg: '<path d="M6.5 6.5h11M12 6.5v12M7 11c1.2.8 3 1.2 5 1.2s3.8-.4 5-1.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
		},
		btc: {
			color: "#f7931a",
			svg: '<path d="M8.5 6.5h5a2.75 2.75 0 0 1 0 5.5h-5zm0 5.5h6a2.75 2.75 0 0 1 0 5.5h-6zm0-5.5v11M10.5 4.5v2m3-2v2m-3 11v2m3-2v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
		},
	}

	const copyText = async text => {
		try {
			await navigator.clipboard.writeText(text)
			return true
		} catch (e) {
			const area = el("textarea", {readonly: ""})
			area.value = text
			document.body.append(area)
			area.select()
			const ok = document.execCommand("copy")
			area.remove()
			return ok
		}
	}

	const renderDonate = () => {
		const methods = [
			{id: "tribute", title: "Чаевые", subtitle: "Tribute", note: "Любая карта мира", value: DONATE.tribute},
			{id: "sbp", title: "СБП", subtitle: "Т-Банк", value: DONATE.sbp},
			{id: "ton", title: "TON", subtitle: "Toncoin", value: DONATE.ton},
			{id: "usdt", title: "USDT", subtitle: `сеть ${DONATE.usdtNetwork}`, value: DONATE.usdt},
			{id: "btc", title: "Bitcoin", subtitle: "BTC", value: DONATE.btc},
		].filter(method => method.value)
		if (!methods.length) return

		$("donate-list").append(
			...methods.map(method => {
				const icon = el("span", {class: "donate-icon"})
				icon.style.background = ICONS[method.id].color
				//static markup from the constants above, never user data
				icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[method.id].svg}</svg>`
				const isLink = /^https?:\/\//.test(method.value)
				const value = isLink ? null : el("div", {class: "donate-value", title: method.value, text: method.value})
				const action = isLink
					? el("a", {
							class: "btn small",
							href: method.value,
							target: "_blank",
							rel: "noopener noreferrer",
							text: method.id === "sbp" ? "Перевести" : "Поддержать",
					  })
					: el("button", {type: "button", class: "btn small", text: "Скопировать"})
				if (!isLink) {
					action.addEventListener("click", async () => {
						const copied = await copyText(method.value)
						if (!copied) {
							//no clipboard access: select the value so it can be copied by hand
							window.getSelection().selectAllChildren(value)
						}
						action.textContent = copied ? "Скопировано ✓" : "Выделено, скопируйте"
						action.classList.toggle("copied", copied)
						setTimeout(() => {
							action.textContent = "Скопировать"
							action.classList.remove("copied")
						}, 2500)
					})
				}
				return el("div", {class: "donate-card"}, [
					el("div", {class: "donate-head"}, [
						icon,
						el("div", {}, [
							el("div", {class: "donate-title", text: method.title}),
							el("div", {class: "donate-subtitle", text: method.subtitle}),
						]),
					]),
					value,
					method.note ? el("div", {class: "donate-note", text: method.note}) : null,
					action,
				])
			})
		)
		$("donate").hidden = false
	}

	renderDonate()
	renderRunState()
})()
