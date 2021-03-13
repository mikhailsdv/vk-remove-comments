let https = require("https")
let readline = require("readline")
let fs = require("fs")
const querystring = require("querystring")
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
})
const ask = (message, yes, no) => {//when user action needed
	rl.question(message, answer => {
		answer === "1" ? (yes && yes()) : (no && no())
	})
}
const ttrim = str => str.replace(/\t+/gm, "")//just removes all tabs

rl.question("Ок, перед тем, как мы начнем, введите свой access_token: ", access_token => {
	access_token = access_token.trim()//idk, just to be sure :)

	if (/^[a-z0-9]{85}$/.test(access_token)) {//seems like valid access_token
		let comments = []//here we gonna store all gathered comments
		let files = fs.readdirSync("./").filter(filename => !["main.js", "start.cmd"].includes(filename))

		files.forEach((file, fileIndex) => {
			fs.readFileSync(file, "utf8").replace(/"https:\/\/vk.com\/wall(-?\d+)_\d+\?reply=(\d+)/g, (match, owner_id, comment_id) => {//why replace? cause it has a nice callback mode
				comments.push({
					owner_id: owner_id,
					comment_id: comment_id,
				})
			})
		})

		ask(
			ttrim(
				`Проверено файлов: ${files.length}
				Комментариев найдено: ${comments.length}

				Процесс удаления займет примерно ${Math.ceil(comments.length * 1.2 / 60)} минут. Запаситесь терпением и стабильным подключением к сети. Следите за процессом — в некоторых ситуациях может понадобится ваше вмешательство.

				Вы действительно хотите удалить все свои комментарии? (1 = да, 0 = нет): `
			),
			() => {//if 1
				console.log("Начинается процесс удаления...")
				
				const removeComment = commentIndex => {//loop
					setTimeout(() => {
						if (commentIndex === comments.length) {//oh, we reached the end!
							console.log("Все ваши комментарии успешно удалены! Можете закрыть консоль и пойти проверить, действительно ли все прошло гладко ;)")
							rl.close()
							return
						}

						let q = querystring.stringify({
							owner_id: comments[commentIndex].owner_id,
							comment_id: comments[commentIndex].comment_id,
							access_token: access_token,
							v: "5.120"
						})
						let req = https.get(`https://api.vk.com/method/wall.deleteComment?${q}`, res => {
							if (res.statusCode === 200) {//this is cool
								let rawData = "";
								res.setEncoding("utf8");
								res.on("data", chunk => {rawData = chunk});
								res.on("end", () => {
									try {
										const parsedData = JSON.parse(rawData);
										if (parsedData.response === 1) {//all is ok
											console.log(`Удалено комментариев ${commentIndex + 1}/${comments.length}`)
											removeComment(++commentIndex)
										}
										else if (parsedData.error && typeof parsedData.error.error_code === "number") {//got an error from vk
											if (parsedData.error.error_code === 5) {//seems like wrong token
												console.log("Что-то не так с вашим токеном. Попробуйте выпустить новый.")
												rl.close()
											}
											else if (parsedData.error.error_code === 211) {//access denied
												console.log(`Нет доступа к комментарию под индексом ${commentIndex}. Возможно, он уже был удален раннее. Продолжаю...`)
												removeComment(++commentIndex)
											}
											else {//hz
												console.log(`Ошибка на комментарии под индексом ${commentIndex}. Причина: `, parsedData)
												removeComment(++commentIndex)
											}
										}
										else if (Object.keys(parsedData).length === 0) {//empty response so comment wasn't removed
											console.log(`Комментарий под индексом ${commentIndex} не найден. Возможно, он уже был удален раннее или паблик был заблокирован. Продолжаю...`)
											removeComment(++commentIndex)
										}
										else {//hz
											console.log(`Ошибка на комментарии под индексом ${commentIndex}. Причина: `, parsedData.error)
											removeComment(++commentIndex)
										}
									}
									catch (e) {//seems like JSON.parse broke
										console.log(`Не удалось прочитать ответ от ВК (${rawData}). Не критично, продолжаю...`)
										removeComment(++commentIndex)
									}
								});
							}
							else {//this is not cool, probably problems with connection
								ask(
									`Ошибка на комментарии под индексом ${commentIndex}: statusCode не равен 200. Возможно, что-то не так с подключением. (1 = продолжить, 0 = остановить): `,
									() => {//if 1
										console.log("Продолжаю с места остановки...")
										removeComment(commentIndex)//not increasing commentIndex, trying one more time
									},
									() => {//if 0
										console.log("Ок, отмена.")
										rl.close()
									}
								)
							}
						})
						req.on("error", e => {
							ask(ttrim(
								`Проблема с запросом к API ВК: ${e.message}

								Возможно, что-то не так с подключением. (1 = продолжить, 0 = остановить): `
							),
								() => {//if 1
									removeComment(commentIndex)//not increasing commentIndex, trying one more time
								},
								() => {//if 0
									console.log("Ок, отмена.")
									rl.close()
								}
							)
						})
						req.end()
					}, 600)//prevent "too many requests"
				}
				removeComment(0)//btw, you can start from any commentIndex
			},
			() => {//if 0
				console.log("Ок, отмена. Начните все сначала, если передумаете.")
				rl.close()
			}
		)
	}
	else {//wrong access_token
		console.log("Ошибка: Не валидный access_token. Проверьте, верно ли вы скопировали данные из адресной строки и попробуйте снова.")
		rl.close()
	}
})