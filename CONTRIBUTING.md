# Как участвовать

Спасибо, что хотите помочь JOKER.

## Куда писать

* Вопросы и идеи: [Discussions](https://github.com/vladimir120307-droid/joker/discussions).
* Ошибки: [Issues](https://github.com/vladimir120307-droid/joker/issues), выберите шаблон «Сообщение об ошибке».
* Уязвимости: только закрытым сообщением, см. [SECURITY.md](SECURITY.md).

## Сборка и проверки

Нужен Node.js 22. Вся подмена живёт в `extension/core.js`; после её правки выполните `node tools/sync-core.js`, чтобы обновить preload браузера для ПК.

| Часть | Команды |
|---|---|
| Расширение | `node tools/build-extension.js all`; тест: `cd tests/extension && npm install && npm run install-browser && npm test` |
| Браузер для ПК | `cd desktop && npm install && npm start`; сборка для Windows: `npm run package && npm run installer` |
| Android | `cd android && ./gradlew :app:assembleDebug`; проверка на эмуляторе: `node android/e2e/run.mjs` |

Автотест браузера для ПК (`npm run selftest`) открывает и сворачивает окна на экране.

## Как прислать изменения

1. Сделайте ветку от `main`; один pull request на одну задачу.
2. Пишите сообщения коммитов по [Conventional Commits](https://www.conventionalcommits.org/), на английском: `fix(android): ...`, `feat(extension): ...`.
3. В описании pull request укажите, что и на чём проверено.

Отправляя изменения, вы соглашаетесь распространять их под лицензией [MIT](LICENSE).
