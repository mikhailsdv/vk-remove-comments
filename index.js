const https = require("https")
const readline = require("readline")
const fs = require("fs")
const querystring = require("querystring")
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
})
const exit = () => rl.close()
const trimMessage = str => str.replace(/\t+/gm, "") //just removes all tabs
const confirm = message =>
	new Promise((resolve, reject) => {
		//when user action needed
		rl.question(trimMessage(message), answer => resolve(answer === "1"))
	})
const ask = message =>
	new Promise((resolve, reject) => {
		//when user input needed
		rl.question(trimMessage(message), resolve)
	})
const sleep = d => new Promise(resolve => setTimeout(resolve, d))

;(async () => {
	const url = await ask(
		`Ок, перед тем, как мы начнем, мне нужно получить ваш access_token. Для этого перейдите по ссылке ниже и разрешите доступ, после чего скопируйте ПОЛНУЮ ссылку из адресной строки и вставьте в это окно. Затем нажмите Enter.
	\nhttps://oauth.vk.com/authorize?client_id=2685278&scope=8192&redirect_uri=https://oauth.vk.com/blank.html&display=page&response_type=token&revoke=1
	\nВставьте ссылку из адресной строки и нажмите Enter: `
	)
	const match = url.match(/^https:\/\/oauth.vk.com\/blank\.html#access_token=(.+?)&/)
	if (!match) {
		//invalid access_token
		console.log(
			"Ошибка: Невалидный access_token. Возможно вы скопировали ссылку не полностью. Проверьте, верно ли вы скопировали данные из адресной строки и попробуйте снова."
		)
		return exit()
	}
	const access_token = match[1]

	const comments = [] //here we gonna store all gathered comments
	const files = fs.readdirSync(__dirname).filter(filename => /^comments\d*\.html$/.test(filename))
	if (files.length === 0) {
		console.log(
			"Ошибка: Не найдено ни одного файла с комментариями. Убедитесь, что вы расположили файлы проекта в директорию comments."
		)
		return exit()
	}
	files.forEach((file, fileIndex) => {
		fs.readFileSync(file, "utf8").replace(
			/"https:\/\/vk.com\/wall(-?\d+)_\d+\?reply=(\d+)/g,
			(match, owner_id, comment_id) => {
				//why replace? cause it has a nice callback mode
				comments.push({
					owner_id: owner_id,
					comment_id: comment_id,
				})
			}
		)
	})

	const confirmStart = await confirm(
		`Проверено файлов: ${files.length}
		Комментариев найдено: ${comments.length}

		Процесс удаления займет примерно ${Math.ceil(
			(comments.length * 1.2) / 60
		)} минут. Запаситесь терпением и стабильным подключением к сети. Следите за процессом — в некоторых ситуациях понадобится ваше вмешательство.

		Вы действительно хотите удалить все свои комментарии? (1 = да, 0 = нет): `
	)
	if (!confirmStart) {
		console.log("Ок, отмена. Начните все сначала, если передумаете.")
		return exit()
	}

	console.log("Начинается процесс удаления...")
	const removeComment = async commentIndex => {
		//loop
		await sleep(550)
		if (commentIndex === comments.length) {
			//oh, we reached the end!
			console.log(
				"Все ваши комментарии успешно удалены! Можете закрыть консоль и пойти проверить, действительно ли все прошло гладко ;)"
			)
			return exit()
		}

		const requestQueryParams = querystring.stringify({
			owner_id: comments[commentIndex].owner_id,
			comment_id: comments[commentIndex].comment_id,
			access_token: access_token,
			v: "5.120",
		})
		const request = https.get(
			`https://api.vk.com/method/wall.deleteComment?${requestQueryParams}`,
			async response => {
				if (response.statusCode === 200) {
					//this is cool
					let rawData = ""
					response.setEncoding("utf8")
					response.on("data", chunk => {
						rawData = chunk
					})
					response.on("end", () => {
						try {
							const parsedData = JSON.parse(rawData)
							if (parsedData.response === 1) {
								//all is ok
								console.log(
									`Удалено комментариев ${commentIndex + 1}/${comments.length}`
								)
								removeComment(++commentIndex)
							} else if (
								parsedData.error &&
								typeof parsedData.error.error_code === "number"
							) {
								//got an error from vk
								if (parsedData.error.error_code === 5) {
									//seems like wrong token
									console.log(
										"Что-то не так с вашим токеном. Попробуйте выпустить новый."
									)
									return exit()
								} else if (parsedData.error.error_code === 211) {
									//access denied
									console.log(
										`Нет доступа к комментарию под индексом ${commentIndex}. Возможно, он уже был удален раннее. Продолжаю...`
									)
									removeComment(++commentIndex)
								} else if (parsedData.error.error_code === 30) {
									//privat profile
									console.log(
										`Нет доступа к комментарию под индексом ${commentIndex}. Профиль этого пользователя отныне закрыт. Продолжаю...`
									)
									removeComment(++commentIndex)
								} else {
									//unknown error
									console.log(
										`Ошибка на комментарии под индексом ${commentIndex}. Причина: `,
										parsedData
									)
									removeComment(++commentIndex)
								}
							} else if (Object.keys(parsedData).length === 0) {
								//empty response so comment wasn't removed
								console.log(
									`Комментарий под индексом ${commentIndex} не найден. Возможно, он уже был удален раннее или паблик был заблокирован. Продолжаю...`
								)
								removeComment(++commentIndex)
							} else {
								//unknown error
								console.log(
									`Ошибка на комментарии под индексом ${commentIndex}. Причина: `,
									parsedData.error
								)
								removeComment(++commentIndex)
							}
						} catch (e) {
							//seems like JSON.parse broke
							console.log(
								`Не удалось прочитать ответ от ВК (${rawData}). Не критично, продолжаю...`
							)
							removeComment(++commentIndex)
						}
					})
				} else {
					//this is not cool, probably connection issues
					const confirmContinue = await confirm(
						`Ошибка на комментарии под индексом ${commentIndex}: statusCode не равен 200. Возможно, что-то не так с вашим подключением к интернету. (1 = продолжить, 0 = остановить): `
					)
					if (!confirmContinue) {
						console.log("Ок, отмена.")
						return exit()
					}

					console.log("Продолжаю с места остановки...")
					removeComment(commentIndex) //not increasing commentIndex, trying one more time
				}
			}
		)
		request.on("error", async e => {
			const confirmContinue = await confirm(
				`Проблема с запросом к API ВК: ${e.message}

					Возможно, что-то не так с подключением. (1 = продолжить, 0 = остановить): `
			)
			if (!confirmContinue) {
				console.log("Ок, отмена.")
				return exit()
			}
			removeComment(commentIndex) //not increasing commentIndex, trying one more time
		})
		request.end()
		//prevent "too many requests"
	}
	removeComment(0) //btw, you can start from any commentIndex
})()
