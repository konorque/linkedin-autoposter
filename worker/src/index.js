// LinkedIn AI Autoposter — Cloudflare Worker
// Cron (каждые 5 мин): черновики из Telegram-каналов → апрув кнопками → публикация в LinkedIn.

import { SYSTEM_PROMPT } from './prompt.js';
import {
  kyivNow,
  publishDecision,
  publishTargetMinutes,
  parseTelegramChannel,
  buildDigest,
  parseAiJson,
  toLinkedInCommentary,
  linkedInVersions,
  pickFormat,
  buildUserPrompt,
} from './lib.js';

const FLAG = { uk: '🇺🇦 UA', ru: '🇷🇺 RU', en: '🇬🇧 EN' };
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ───────────────────────── База (D1) ─────────────────────────

async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
    .bind(key, value === null ? null : String(value))
    .run();
}

async function countByStatus(env) {
  const { results } = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM posts GROUP BY status').all();
  return Object.fromEntries(results.map((r) => [r.status, r.n]));
}

// ───────────────────────── Telegram ─────────────────────────

async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

async function tgSafe(env, method, body) {
  try {
    return await tg(env, method, body);
  } catch (e) {
    console.log('tgSafe', method, e.message);
    return null;
  }
}

const notify = (env, text, extra = {}) =>
  tgSafe(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true, ...extra });

/** Ошибку шлём в Telegram не чаще раза в час на каждый вид ошибки. */
async function alertError(env, kind, err) {
  const now = kyivNow();
  const key = `alert_${kind}`;
  const stamp = `${now.day} ${now.hour}`;
  if ((await getSetting(env, key)) === stamp) return;
  await setSetting(env, key, stamp);
  await notify(env, `⚠️ Ошибка (${kind}):\n${String(err && err.message ? err.message : err).slice(0, 1500)}`);
}

// ───────────────────────── Нейросети ─────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

async function callGemini(env, model, system, user) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  // Перегрузка (503) или лимит (429) — одна повторная попытка через 3 секунды
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 8192, responseMimeType: 'application/json' },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
      if (!text) throw new Error(`${model}: пустой ответ ${JSON.stringify(data).slice(0, 300)}`);
      return text;
    }
    const err = `${model} ${res.status}: ${JSON.stringify(data?.error?.message || data).slice(0, 300)}`;
    if ((res.status === 503 || res.status === 429) && attempt === 1) {
      await sleep(3000);
      continue;
    }
    throw new Error(err);
  }
}

async function callOpenRouter(env, models, system, user) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
    body: JSON.stringify({
      // OpenRouter сам перебирает модели из списка, если первая недоступна
      models,
      temperature: 0.8,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(data?.error?.message || data).slice(0, 300)}`);
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter: пустой ответ');
  return { text, model: data.model || models[0] };
}

/** Цепочка: модели Gemini по очереди → OpenRouter (бесплатные модели). */
async function generatePost(env, user) {
  const errors = [];
  for (const model of list(env.GEMINI_MODELS || env.GEMINI_MODEL)) {
    try {
      return { data: parseAiJson(await callGemini(env, model, SYSTEM_PROMPT, user)), model, fallbackReason: errors.join('\n') || null };
    } catch (e) {
      console.log('AI failed:', e.message);
      errors.push(e.message);
    }
  }
  if (env.OPENROUTER_API_KEY) {
    try {
      const { text, model } = await callOpenRouter(env, list(env.OPENROUTER_MODELS || env.OPENROUTER_MODEL), SYSTEM_PROMPT, user);
      return { data: parseAiJson(text), model, fallbackReason: errors.join('\n') };
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error('Все нейросети недоступны:\n' + errors.join('\n\n'));
}

// ───────────────────────── Черновики ─────────────────────────

async function runDrafts(env, { force = false } = {}) {
  const now = kyivNow();

  if (!force) {
    if (now.hour < 9 || now.hour >= 14) return 'not-time';
    const counts = await countByStatus(env);
    if ((counts.approved || 0) >= 3) return 'queue-full';
    const fresh = await env.DB.prepare(
      "SELECT 1 FROM posts WHERE status = 'draft' AND created_at > datetime('now', '-20 hours') LIMIT 1",
    ).first();
    if (fresh) return 'waiting-approval';
    // не больше одной автоматической попытки в час (если каналы пустые или ИИ упал)
    const stamp = `${now.day} ${now.hour}`;
    if ((await getSetting(env, 'drafts_try')) === stamp) return 'tried-this-hour';
    await setSetting(env, 'drafts_try', stamp);
  }

  const { results: usedRows } = await env.DB.prepare(
    "SELECT DISTINCT source_url FROM posts WHERE source_url IS NOT NULL AND source_url != ''",
  ).all();
  const usedUrls = new Set(usedRows.map((r) => r.source_url));

  const channels = String(env.CHANNELS || '')
    .split(',')
    .map((s) => s.trim().replace(/^https?:\/\/t\.me\/(s\/)?/, '').replace(/^@/, ''))
    .filter(Boolean);

  const pages = await Promise.all(
    channels.map(async (ch) => {
      try {
        const res = await fetch(`https://t.me/s/${ch}`, { headers: { 'user-agent': BROWSER_UA } });
        return res.ok ? await res.text() : '';
      } catch {
        return '';
      }
    }),
  );
  const posts = pages.flatMap((html) => parseTelegramChannel(html, { usedUrls }));
  const { digest, count } = buildDigest(posts, 30);
  if (!count) {
    if (force) await notify(env, '🤷 Свежих постов в каналах за 48 часов не нашлось. Попробую позже.');
    return 'no-posts';
  }

  const format = pickFormat();
  const { data, model, fallbackReason } = await generatePost(env, buildUserPrompt(format, digest));

  const topicId = 't' + Date.now().toString(36);
  const langs = ['uk', 'ru', 'en'];
  const stmt = env.DB.prepare(
    "INSERT INTO posts (topic_id, lang, seq, text, status, source_url) VALUES (?, ?, ?, ?, 'draft', ?)",
  );
  await env.DB.batch(
    langs.map((lang, i) => stmt.bind(topicId, lang, i + 1, String(data[lang]).trim().slice(0, 2900), data.source_url || '')),
  );

  await tg(env, 'sendMessage', {
    chat_id: env.TELEGRAM_CHAT_ID,
    disable_web_page_preview: true,
    text:
      `📝 Новый черновик ${topicId}\nФормат: ${format} · модель: ${model}\nИсточник: ${data.source_url || '—'}` +
      (fallbackReason ? `\n(основная модель недоступна, сработал резерв)` : ''),
  });
  for (let i = 0; i < langs.length; i++) {
    const lang = langs[i];
    const body = {
      chat_id: env.TELEGRAM_CHAT_ID,
      disable_web_page_preview: true,
      text: `${FLAG[lang]}\n\n${String(data[lang]).trim()}`.slice(0, 4000),
    };
    if (i === langs.length - 1) {
      body.reply_markup = {
        inline_keyboard: [
          [
            { text: '✅ Опубликовать', callback_data: `approve:${topicId}` },
            { text: '🔄 Другая тема', callback_data: `regen:${topicId}` },
            { text: '❌ Пропустить', callback_data: `skip:${topicId}` },
          ],
        ],
      };
    }
    await tg(env, 'sendMessage', body);
  }
  return 'sent';
}

// ───────────────────────── LinkedIn ─────────────────────────

async function linkedInPost(env, text) {
  const token = await getSetting(env, 'li_token');
  const person = await getSetting(env, 'li_person');
  if (!token || !person) throw new Error('LinkedIn не подключён. Открой /linkedin/connect?key=ADMIN_KEY');

  const body = JSON.stringify({
    author: `urn:li:person:${person}`,
    commentary: toLinkedInCommentary(text),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  });

  // Сначала версия, которая сработала в прошлый раз, затем от текущего месяца назад
  const saved = await getSetting(env, 'li_version');
  const versions = [...new Set([saved, ...linkedInVersions()].filter(Boolean))];
  let lastError = '';
  for (const version of versions) {
    const res = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'LinkedIn-Version': version,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body,
    });
    if (res.ok) {
      if (version !== saved) await setSetting(env, 'li_version', version);
      return res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id') || '';
    }
    lastError = `${res.status} ${(await res.text()).slice(0, 400)}`;
    // неактивная версия API — пробуем следующую, иначе это настоящая ошибка
    if (!(res.status === 426 || /version/i.test(lastError))) break;
  }
  throw new Error('LinkedIn: ' + lastError);
}

async function publishNext(env) {
  const next = await env.DB.prepare(
    "SELECT * FROM posts WHERE status = 'approved' ORDER BY id ASC LIMIT 1",
  ).first();
  if (!next) return null;
  const postId = await linkedInPost(env, next.text);
  const now = kyivNow();
  await env.DB.prepare(
    "UPDATE posts SET status = 'published', linkedin_post_id = ?, published_at = datetime('now'), published_day = ? WHERE id = ?",
  )
    .bind(postId, now.day, next.id)
    .run();
  const link = postId ? `\nhttps://www.linkedin.com/feed/update/${postId}/` : '';
  await notify(env, `✅ Опубликовано в LinkedIn (${FLAG[next.lang] || next.lang}):${link}\n\n${next.text.slice(0, 200)}…`);
  return next;
}

async function runPublisher(env) {
  const now = kyivNow();
  const publishedToday = await env.DB.prepare(
    "SELECT 1 FROM posts WHERE status = 'published' AND published_day = ? LIMIT 1",
  )
    .bind(now.day)
    .first();
  const hasApproved = await env.DB.prepare("SELECT 1 FROM posts WHERE status = 'approved' LIMIT 1").first();
  const decision = publishDecision({ now, publishedToday: !!publishedToday, hasApproved: !!hasApproved });
  if (decision.action !== 'publish') return 'skip';
  if (decision.waitSec > 0) await new Promise((r) => setTimeout(r, decision.waitSec * 1000));
  await publishNext(env);
  return 'published';
}

/** Раз в день утром предупреждаем, если токен LinkedIn скоро истечёт. */
async function checkToken(env) {
  const now = kyivNow();
  if (now.hour !== 9) return;
  if ((await getSetting(env, 'token_check_day')) === now.day) return;
  await setSetting(env, 'token_check_day', now.day);
  const exp = Number(await getSetting(env, 'li_expires_at'));
  if (!exp) {
    await notify(env, '⚠️ LinkedIn не подключён. Открой ссылку подключения из инструкции.');
    return;
  }
  const daysLeft = Math.floor((exp - Date.now()) / 86400e3);
  if (daysLeft <= 7) {
    await notify(env, `⚠️ Токен LinkedIn истекает через ${daysLeft} дн. Переподключи: открой ${env.PUBLIC_URL}/linkedin/connect?key=<ADMIN_KEY>`);
  }
}

// ───────────────────────── Кнопки и команды ─────────────────────────

async function handleTelegramUpdate(env, update, ctx) {
  const chatId = String(env.TELEGRAM_CHAT_ID);

  const cq = update.callback_query;
  if (cq) {
    if (String(cq.from.id) !== chatId) {
      await tgSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Нет доступа' });
      return;
    }
    const [action, topicId] = String(cq.data || '').split(':');
    const map = {
      approve: ['approved', '✅ Одобрено. Посты встали в очередь.'],
      skip: ['skipped', '❌ Пропущено.'],
      regen: ['skipped', '🔄 Принято. Новая тема придёт в течение 5 минут.'],
    };
    if (!map[action] || !topicId) return;
    const [status, reply] = map[action];
    const res = await env.DB.prepare("UPDATE posts SET status = ? WHERE topic_id = ? AND status = 'draft'")
      .bind(status, topicId)
      .run();
    const changed = res.meta && res.meta.changes;
    await tgSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: changed ? reply : 'Уже обработано' });
    await tgSafe(env, 'editMessageReplyMarkup', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
    if (changed) {
      await tgSafe(env, 'sendMessage', {
        chat_id: cq.message.chat.id,
        text: reply,
        reply_parameters: { message_id: cq.message.message_id },
      });
      if (action === 'regen') await setSetting(env, 'pending_generate', '1');
    }
    return;
  }

  const msg = update.message;
  if (!msg || String(msg.chat.id) !== chatId || !msg.text) return;
  const cmd = msg.text.trim().split(/\s+/)[0].split('@')[0];

  if (cmd === '/start' || cmd === '/help') {
    await notify(
      env,
      'Команды:\n/status — очередь и ближайшая публикация\n/generate — сгенерировать новую тему (в течение 5 минут)\n/publish_now — опубликовать следующий пост из очереди прямо сейчас',
    );
  } else if (cmd === '/status') {
    const counts = await countByStatus(env);
    const now = kyivNow();
    const t = publishTargetMinutes(now.day);
    const exp = Number(await getSetting(env, 'li_expires_at'));
    const expText = exp ? new Date(exp).toISOString().slice(0, 10) : 'не подключён';
    await notify(
      env,
      `📊 Очередь: approved ${counts.approved || 0}, draft ${counts.draft || 0}, опубликовано ${counts.published || 0}\n` +
        `Время публикации сегодня: ${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')} (Киев, ежедневно)\n` +
        `Токен LinkedIn до: ${expText}`,
    );
  } else if (cmd === '/generate') {
    await setSetting(env, 'pending_generate', '1');
    await notify(env, '🔄 Сгенерирую новую тему в течение 5 минут.');
  } else if (cmd === '/publish_now') {
    ctx.waitUntil(
      publishNext(env)
        .then((p) => (p ? null : notify(env, 'Очередь пуста: нет одобренных постов.')))
        .catch((e) => notify(env, '❌ Ошибка публикации: ' + e.message)),
    );
  }
}

// ───────────────────────── HTTP ─────────────────────────

const html = (body, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px">${body}</body>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);
  const origin = env.PUBLIC_URL || url.origin;
  const isAdmin = url.searchParams.get('key') === env.ADMIN_KEY && !!env.ADMIN_KEY;

  if (url.pathname === '/telegram/webhook' && request.method === 'POST') {
    if (request.headers.get('x-telegram-bot-api-secret-token') !== env.TG_WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const update = await request.json();
    try {
      await handleTelegramUpdate(env, update, ctx);
    } catch (e) {
      console.log('webhook error', e.message);
      ctx.waitUntil(alertError(env, 'telegram', e));
    }
    return new Response('ok');
  }

  if (url.pathname === '/setup') {
    if (!isAdmin) return html('Нет доступа', 403);
    await tg(env, 'setWebhook', {
      url: `${origin}/telegram/webhook`,
      secret_token: env.TG_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
    await tgSafe(env, 'setMyCommands', {
      commands: [
        { command: 'status', description: 'Очередь и ближайшая публикация' },
        { command: 'generate', description: 'Сгенерировать новую тему' },
        { command: 'publish_now', description: 'Опубликовать следующий пост сейчас' },
      ],
    });
    await notify(env, '🤖 Бот переехал в облако (Cloudflare). Напиши /status, чтобы проверить.');
    return html('✅ Webhook Telegram настроен. Проверь сообщение от бота.');
  }

  if (url.pathname === '/linkedin/connect') {
    if (!isAdmin) return html('Нет доступа', 403);
    const state = crypto.randomUUID();
    await setSetting(env, 'oauth_state', state);
    const auth = new URL('https://www.linkedin.com/oauth/v2/authorization');
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', env.LINKEDIN_CLIENT_ID);
    auth.searchParams.set('redirect_uri', `${origin}/linkedin/callback`);
    auth.searchParams.set('scope', 'openid profile w_member_social');
    auth.searchParams.set('state', state);
    return Response.redirect(auth.toString(), 302);
  }

  if (url.pathname === '/linkedin/callback') {
    const state = url.searchParams.get('state');
    if (!state || state !== (await getSetting(env, 'oauth_state'))) return html('Неверный state, начни подключение заново', 400);
    await setSetting(env, 'oauth_state', null);
    if (url.searchParams.get('error')) return html('LinkedIn вернул ошибку: ' + url.searchParams.get('error_description'), 400);

    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: url.searchParams.get('code') || '',
        redirect_uri: `${origin}/linkedin/callback`,
        client_id: env.LINKEDIN_CLIENT_ID,
        client_secret: env.LINKEDIN_CLIENT_SECRET,
      }),
    });
    const tok = await tokenRes.json().catch(() => ({}));
    if (!tok.access_token) return html('Не удалось получить токен: ' + JSON.stringify(tok).slice(0, 300), 400);

    const me = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { authorization: `Bearer ${tok.access_token}` },
    }).then((r) => r.json());
    if (!me.sub) return html('Не удалось получить профиль: ' + JSON.stringify(me).slice(0, 300), 400);

    const expiresAt = Date.now() + Number(tok.expires_in || 5184000) * 1000;
    await setSetting(env, 'li_token', tok.access_token);
    await setSetting(env, 'li_person', me.sub);
    await setSetting(env, 'li_expires_at', expiresAt);
    const until = new Date(expiresAt).toISOString().slice(0, 10);
    await notify(env, `🔗 LinkedIn подключён (${me.name || me.sub}). Токен действует до ${until}.`);
    return html(`✅ LinkedIn подключён: ${me.name || me.sub}. Токен действует до ${until}.`);
  }

  return new Response('LinkedIn AI Autoposter is running');
}

// ───────────────────────── Cron ─────────────────────────

async function handleScheduled(env) {
  // 1. Генерация по запросу (кнопка «Другая тема» или /generate)
  if ((await getSetting(env, 'pending_generate')) === '1') {
    await setSetting(env, 'pending_generate', '0');
    try {
      await runDrafts(env, { force: true });
    } catch (e) {
      await notify(env, '⚠️ Ошибка генерации:\n' + String(e.message).slice(0, 1500));
    }
  }

  // 2. Плановая генерация (ежедневно 9:00–14:00, если очередь заканчивается)
  try {
    await runDrafts(env);
  } catch (e) {
    await alertError(env, 'drafts', e);
  }

  // 3. Публикация (ежедневно, включая выходные, случайное время 10:00–13:44)
  try {
    await runPublisher(env);
  } catch (e) {
    await alertError(env, 'publish', e);
  }

  // 4. Проверка срока токена LinkedIn
  try {
    await checkToken(env);
  } catch (e) {
    console.log('token check', e.message);
  }
}

export default {
  fetch: handleFetch,
  async scheduled(event, env, ctx) {
    await handleScheduled(env);
  },
};