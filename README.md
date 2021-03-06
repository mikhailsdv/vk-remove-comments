# vk-remove-comments
Небольшой Node.js скрипт, который удаляет все ваши комментарии в ВК.

## Предисловие
Как известно, в ВК API не существует ни одного метода, который бы позволил получить весь список комментариев пользователя. Большинство программ по очистке могут удалять лайки / посты / фото, но комментарии не могут. С помощью данного гайда вы легко сможете удалить все когда-либо оставленные вами комментарии в ВК.

## О безопасности аккаунта и конфиденциальности данных
На одном из этапов скрипт требует ввода вашего `access_token`, но получаете вы его с помощью официального приложения [VK API](https://vk.com/app3116505), следовательно никто не сможет угнать ваш `access_token`. Вы также можете убедиться в том, что ваш токен не отправляется третьим лицам, взглянув в код.

## Порядок действий
Рекомендую сначала прочесть весь мануал и только потом приступать к выполнению.

1. Установите [Node.js](https://nodejs.org/en/download/).
2. Запросите свой архив ВК по ссылке https://vk.cc/8Irnch. Не забудьте поставить галочку у пункта «Комментарии» в разделе «Прочее». В течение пары дней вы получите архив.
3. Когда архив будет готов, скачайте и распакуйте его в любом месте на компьютере.
4. [Скачайте файлы из репозитория](https://github.com/mikhailsdv/vk-remove-comments/archive/master.zip) и переместите их в папку `comments` из распакованного архива.
5. Запустите скрипт. Есть несколько вариантов запуска.
  * На Windows запустите `start.cmd`.
  * На UNIX запустите `start.sh`.
  * На любой ОС можете просто запустить скрипт, в терминале наберите `node main.js`. И `start.cmd`, и `start.sh` делают то же самое, по сути.
6. Скрипт попросит вас ввести токен. Чтобы получить токен, перейдите по ссылке [https://oauth.vk.com/authorize?client_id=…](https://oauth.vk.com/authorize?client_id=3116505&scope=1073737727&redirect_uri=https://oauth.vk.com/blank.html&display=page&response_type=token&revoke=1)
7. Нажмите «Разрешить» (войдите в аккаунт, если потребуется).
8. Скопируйте часть адресной строки от `access_token=` до `&expires_in` (не включительно) и вставьте ее в консоль. Затем нажмите Enter.
9. Скрипт проанализирует все ваши комментарии и выведет на экране сколько всего комментариев будет удалено и сколько времени это займет. Если готовы, введите 1 и нажмите Enter. Дождитесь окончания удаления.

## Фидбэк
Если вы обнаружите сбои в работе скрипта, присылайте скриншоты в мой Телеграм [@mikhailsdv](https://t.me/mikhailsdv).
