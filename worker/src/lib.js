// Чистые функции без доступа к сети и базе — их легко тестировать локально.

/** Текущие дата и время по Киеву. */
export function kyivNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour,
    minute,
    minutes: hour * 60 + minute,
    isWeekday: !['Sat', 'Sun'].includes(p.weekday),
  };
}

/** Случайное, но одинаковое на весь день время публикации: 10:00 + 0…224 мин (в минутах от полуночи). */
export function publishTargetMinutes(day) {
  let h = 0;
  for (const c of day) h = (h * 31 + c.charCodeAt(0)) % 100000;
  return 600 + (h % 225);
}

/**
 * Решение планировщика публикации.
 * Возвращает { action: 'skip' } | { action: 'publish', waitSec } .
 * tickMinutes — интервал cron (5): если до целевого времени меньше интервала, ждём внутри запуска.
 */
export function publishDecision({ now, publishedToday, hasApproved, tickMinutes = 5, catchUpUntil = 14 * 60 }) {
  if (publishedToday || !hasApproved) return { action: 'skip' };
  const target = publishTargetMinutes(now.day);
  if (now.minutes > catchUpUntil) return { action: 'skip' };
  if (now.minutes >= target) return { action: 'publish', waitSec: 0 };
  const left = target - now.minutes;
  if (left < tickMinutes) return { action: 'publish', waitSec: left * 60 };
  return { action: 'skip' };
}

const decodeHtml = (s) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#33;/g, '!')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();

/** Разбор веб-превью публичного канала https://t.me/s/<канал>. */
export function parseTelegramChannel(html, { usedUrls = new Set(), maxAgeMs = 48 * 3600e3, now = Date.now() } = {}) {
  const posts = [];
  const blocks = String(html).split('tgme_widget_message_wrap').slice(1);
  for (const b of blocks) {
    const post = (b.match(/data-post="([^"]+)"/) || [])[1];
    const body = (b.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/) || [])[1];
    const dt = (b.match(/<time[^>]*datetime="([^"]+)"/) || [])[1];
    if (!post || !body || !dt) continue;
    const url = 'https://t.me/' + post;
    if (usedUrls.has(url)) continue;
    if (now - new Date(dt).getTime() > maxAgeMs) continue;
    const text = decodeHtml(body);
    if (text.length < 120) continue; // короткий мусор
    posts.push({ url, date: dt, text: text.slice(0, 1200) });
  }
  return posts;
}

/** Склеиваем посты всех каналов в дайджест для нейросети. */
export function buildDigest(posts, limit = 30) {
  const top = [...posts].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, limit);
  return {
    count: top.length,
    digest: top.map((p, i) => `[${i + 1}] ${p.url}\n${p.text}`).join('\n\n---\n\n'),
  };
}

/** Достаём JSON из ответа нейросети. */
export function parseAiJson(raw) {
  let s = String(raw || '').replace(/```json|```/g, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('Нейросеть не вернула JSON: ' + s.slice(0, 300));
  const data = JSON.parse(s.slice(start, end + 1));
  for (const l of ['uk', 'ru', 'en']) {
    if (!data[l] || !String(data[l]).trim()) throw new Error('В ответе нет версии ' + l);
  }
  return data;
}

/**
 * Текст поста → формат commentary для LinkedIn Posts API («little text»).
 * Служебные символы экранируются, иначе LinkedIn обрезает текст.
 * Хэштеги превращаются в шаблон {hashtag|\#|Tag}.
 */
export function toLinkedInCommentary(text) {
  const tags = [];
  const withPlaceholders = String(text).replace(/#([\p{L}\p{N}]+)/gu, (_, tag) => {
    tags.push(tag);
    return `\u0000${tags.length - 1}\u0000`;
  });
  const escaped = withPlaceholders.replace(/[\\|{}@\[\]()<>#*_~]/g, (m) => '\\' + m);
  return escaped.replace(/\u0000(\d+)\u0000/g, (_, i) => `{hashtag|\\#|${tags[Number(i)]}}`);
}

/** Версии LinkedIn API (YYYYMM) от текущего месяца назад — пробуем по очереди, пока одна не подойдёт. */
export function linkedInVersions(date = new Date(), count = 12) {
  const out = [];
  let y = date.getUTCFullYear();
  let m = date.getUTCMonth() + 1;
  for (let i = 0; i < count; i++) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

/** Случайный формат поста: «опыт» в 2/3 случаев, «мнение» в 1/3. */
export function pickFormat(rand = Math.random()) {
  return rand < 2 / 3 ? 'опыт' : 'мнение';
}

export function buildUserPrompt(format, digest) {
  return `Формат этого поста: ${format}.

Ниже — свежие посты из отраслевых Telegram-каналов за последние 48 часов. Каждый начинается с [номер] и ссылкой.

Выбери ОДНУ тему — самую интересную и полезную для аудитории LinkedIn (медиабаеры, affiliate- и performance-маркетологи). Приоритет: изменения рекламных платформ, тренды рынка, кейсы с выводами. Избегай рекламы, вакансий, розыгрышей и мемов без смысла.

Напиши по теме пост в трёх версиях: украинская (uk), русская (ru), английская (en). Не дословный перевод: каждая версия должна звучать естественно для носителя языка.

Ответь ТОЛЬКО валидным JSON без markdown, строго в формате:
{"topic": "тема кратко на русском", "source_url": "ссылка выбранного поста", "uk": "текст", "ru": "текст", "en": "текст"}

Посты:
${digest}`;
}
