# Setup guide

Everything below is free. Approximate time: 1.5–2 hours.

## 1. Run n8n

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/), start it, then:

```bash
docker run -d --name n8n --restart unless-stopped -p 5678:5678 \
  -e GENERIC_TIMEZONE=Europe/Kyiv -e TZ=Europe/Kyiv \
  -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n
```

Open `http://localhost:5678` and create the owner account.

> The PC must be on during working hours (09:00–13:44) for the schedule to work. For 24/7 operation use `deploy/` on a VPS.

## 2. LinkedIn app

Log in to LinkedIn with your **personal account** (the one that will publish posts).

1. LinkedIn requires every developer app to be linked to a Company Page. If you don't have one, create a simple page: *For Business → Create a Company Page*.
2. Go to <https://www.linkedin.com/developers/apps> → **Create app**. Select **your own** page (not the default "LinkedIn" page — the link can't be changed later).
3. **Settings** → verify the page link if it shows *Unverified*.
4. **Products** → request access to:
   - **Share on LinkedIn**
   - **Sign In with LinkedIn using OpenID Connect**
5. **Auth** → *Authorized redirect URLs* → add `http://localhost:5678/rest/oauth2-credential/callback`.
6. Copy **Client ID** and **Client Secret**.

## 3. Telegram bot

1. In Telegram open **@BotFather** → `/newbot` → save the token.
2. Open your new bot and press **Start** (otherwise it can't message you).
3. Get your chat ID from **@userinfobot**.

> Never share the bot token or show it on screenshots. If it leaks: @BotFather → `/revoke`.

## 4. Gemini API key

Open <https://aistudio.google.com> with any Google account → **Get API key** → **Create API key**.

## 5. Credentials in n8n

**+** → **Credential**:

| Credential | Values |
|---|---|
| **LinkedIn OAuth2 API** | Client ID, Client Secret. *Organization Support* off, *Legacy* off. Press **Connect** and log in with your personal LinkedIn account. |
| **Telegram API** | Bot token |
| **Google Gemini(PaLM) Api** | Gemini API key |

If LinkedIn returns `unauthorized_scope_error: r_emailaddress`, the *Legacy* toggle is on — turn it off and reconnect.

## 6. Data table

Overview → **Data tables** → **Create data table** → name `Posts`. Add columns:

| Column | Type |
|---|---|
| `topic_id` | String |
| `lang` | String |
| `seq` | Number |
| `text` | String |
| `status` | String |
| `source_url` | String |
| `linkedin_post_id` | String |
| `published_at` | Date |

## 7. Your LinkedIn person ID

Create a temporary workflow with an **HTTP Request** node:

- Method `GET`, URL `https://api.linkedin.com/v2/userinfo`
- Authentication: *Predefined Credential Type* → *LinkedIn OAuth2 API*

Execute it and copy the `sub` field.

## 8. Import workflows

For each file in `workflows/`: **+** → **Workflow** → **⋯** → **Import from File**. Then fix the parts that can't be imported:

**wf4-publisher.json**
- `Config`: `person_id` = your `sub`, `telegram_chat_id` = your chat ID.
- Both Data Table nodes: select `Posts`. Recreate filter conditions with **Equals** if they show a red warning.
- LinkedIn and Telegram nodes: select credentials.

**wf2-drafts.json**
- `Config`: `bot_token`, `telegram_chat_id`, `channels` (comma-separated usernames of **public channels**; group chats have no web preview and return nothing).
- Data Table nodes: select `Posts`; *Save drafts* → mapping **Map Automatically**.
- `Gemini` node: select credential and the latest **Flash** model, max tokens `8192`.
- Optionally edit the system message in `Генерация поста` (source: `../prompts/system-prompt.md`).

**wf3-approval-buttons.json**
- `Config`: `bot_token`, `telegram_chat_id`.
- `Обновить статус`: table `Posts`, conditions `topic_id` **Equals** `{{ $json.topic_id }}` and `status` **Equals** `draft`.
- `Запустить WF2`: select the WF2 workflow.

## 9. Test and activate

1. WF2 → **Execute** → *Тест вручную* → a draft arrives in Telegram.
2. WF3 → **Publish** → press ✅ in Telegram → rows become `approved` within a minute.
3. WF4 → **Execute** → *Тест вручную* → the post appears on LinkedIn.
4. Press **Publish** on WF2 and WF4.

## Maintenance

- **LinkedIn token lives 60 days** and has no refresh token on self-serve apps. When WF4 sends a 401 alert: Credentials → *LinkedIn account* → **Reconnect**.
- Gemini free-tier limits change often. In WF2 the *Генерация поста* node has a fallback model (OpenRouter Chat Model → `google/gemma-4-31b-it:free`); enable *Enable Fallback Model* and connect it.
