# Деплой на Cloudflare Workers (Windows)

Всё бесплатно, карта не нужна. После деплоя компьютер можно выключать: бот работает в облаке 24/7.

## Что получится

- Каждые 5 минут в облаке запускается проверка.
- Каждый день, включая выходные, 9:00–14:00 (Киев): если в очереди меньше 3 одобренных постов — бот присылает новый черновик с кнопками.
- Каждый день, включая выходные, 10:00–13:44: в случайное время публикуется следующий одобренный пост.
- Кнопки в Telegram срабатывают мгновенно.
- Команды боту: `/status`, `/generate`, `/publish_now`.
- За 7 дней до истечения токена LinkedIn бот напомнит переподключить.

---

## 1. Подготовка (один раз)

1. Установи **Node.js LTS** с https://nodejs.org (кнопка LTS → установщик → «Далее» до конца).
2. Зарегистрируйся на https://dash.cloudflare.com/sign-up — **любая твоя почта**, карта не нужна. Подтверди почту.
3. Распакуй архив. Открой **PowerShell** в папке `worker`:
   ```powershell
   cd "C:\путь\к\linkedin-ai-autoposter\worker"
   ```

## 2. Вход в Cloudflare

```powershell
npx wrangler login
```
Откроется браузер — войди в **свой аккаунт Cloudflare** и нажми **Allow**. На вопрос «Ok to proceed?» в PowerShell ответь `y`.

## 3. База данных

```powershell
npx wrangler d1 create autoposter
```
В ответе будет строка `database_id = "…"`. Открой `wrangler.toml` в Блокноте и вставь этот id вместо `ВСТАВЬ_ID_БАЗЫ`. Сохрани.

Создай таблицы:
```powershell
npx wrangler d1 execute autoposter --remote --file=schema.sql
```

## 4. Первый деплой

```powershell
npx wrangler deploy
```
- Если спросит про регистрацию поддомена `workers.dev` — согласись и придумай короткое имя (например, свой ник).
- В конце будет адрес вида `https://linkedin-autoposter.<ник>.workers.dev`. **Сохрани его** — дальше это `<АДРЕС>`.

Открой `wrangler.toml`, впиши адрес в `PUBLIC_URL = "https://linkedin-autoposter.<ник>.workers.dev"` (без `/` в конце) и сохрани.

## 5. Секреты

Каждая команда попросит вставить значение (ввод не отображается — это нормально, вставь Ctrl+V и Enter).

Сначала придумай два случайных пароля — выполни команду дважды и сохрани оба значения:
```powershell
[guid]::NewGuid().ToString("N")
```
Первый — для `TG_WEBHOOK_SECRET`, второй — для `ADMIN_KEY` (это ключ для служебных ссылок, храни его как пароль).

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN      # токен бота от @BotFather
npx wrangler secret put TELEGRAM_CHAT_ID        # твой chat ID (7804…)
npx wrangler secret put TG_WEBHOOK_SECRET       # первый случайный пароль
npx wrangler secret put ADMIN_KEY               # второй случайный пароль
npx wrangler secret put GEMINI_API_KEY          # ключ из aistudio.google.com
npx wrangler secret put OPENROUTER_API_KEY      # ключ OpenRouter
npx wrangler secret put LINKEDIN_CLIENT_ID      # Client ID приложения Auto-posts
npx wrangler secret put LINKEDIN_CLIENT_SECRET  # Client Secret приложения Auto-posts
```

Задеплой ещё раз (чтобы подхватился `PUBLIC_URL`):
```powershell
npx wrangler deploy
```

## 6. LinkedIn: новый redirect URL

Войди в LinkedIn **личным аккаунтом** → https://www.linkedin.com/developers/apps → приложение **Auto-posts** → вкладка **Auth** → **Authorized redirect URLs** → карандаш → **Add redirect URL**:
```
<АДРЕС>/linkedin/callback
```
→ **Update**. Старый `localhost`-адрес можно оставить.

## 7. Выключи n8n

Бот не может одновременно работать в n8n и в облаке. В n8n у **WF2, WF3, WF4**: стрелка рядом с **Published** → **Unpublish**.

> Одобренные посты из таблицы n8n в облако не переносятся — очередь начнётся заново, бот сам пришлёт новый черновик.

## 8. Подключение

1. Открой в браузере (подставь свои значения):
   ```
   <АДРЕС>/setup?key=<ADMIN_KEY>
   ```
   Должно появиться «✅ Webhook Telegram настроен», а бот напишет «Бот переехал в облако».

2. Открой:
   ```
   <АДРЕС>/linkedin/connect?key=<ADMIN_KEY>
   ```
   Войди **личным аккаунтом LinkedIn** → **Allow**. Бот напишет «LinkedIn подключён… Токен действует до …».

## 9. Проверка

1. Напиши боту `/status` — придёт состояние очереди.
2. Напиши `/generate` — в течение 5 минут придёт черновик с кнопками.
3. Нажми ✅ — бот сразу ответит «Одобрено».
4. Публикация пойдёт по расписанию. Чтобы проверить сразу — `/publish_now` (пост выйдет публично).

## Полезное

- Логи в реальном времени: `npx wrangler tail`
- Изменил код, промпт или список каналов в `wrangler.toml` → `npx wrangler deploy`
- Посмотреть очередь:
  ```powershell
  npx wrangler d1 execute autoposter --remote --command "SELECT id, lang, status, substr(text,1,40) FROM posts ORDER BY id DESC LIMIT 10"
  ```
- Переподключить LinkedIn (раз в ~60 дней, бот напомнит): снова открыть `<АДРЕС>/linkedin/connect?key=<ADMIN_KEY>`.
