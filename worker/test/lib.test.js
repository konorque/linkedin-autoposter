import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kyivNow, publishTargetMinutes, publishDecision, parseTelegramChannel,
  buildDigest, parseAiJson, toLinkedInCommentary, linkedInVersions, pickFormat,
  pickLength, postEdges, buildUserPrompt,
} from '../src/lib.js';

test('kyivNow: зимой UTC+2', () => {
  const n = kyivNow(new Date('2026-11-23T08:30:00Z')); // понедельник
  assert.equal(n.day, '2026-11-23');
  assert.equal(n.hour, 10);
  assert.equal(n.minute, 30);
  assert.equal(n.isWeekday, true);
  assert.equal(kyivNow(new Date('2026-11-22T10:00:00Z')).isWeekday, false); // воскресенье
});

test('kyivNow: летом UTC+3', () => {
  assert.equal(kyivNow(new Date('2026-07-01T07:00:00Z')).hour, 10);
});

test('publishTargetMinutes в окне 10:00–13:44 и стабилен', () => {
  for (let d = 1; d <= 28; d++) {
    const day = `2026-12-${String(d).padStart(2, '0')}`;
    const t = publishTargetMinutes(day);
    assert.ok(t >= 600 && t <= 824, `${day}: ${t}`);
    assert.equal(t, publishTargetMinutes(day));
  }
});

test('publishDecision', () => {
  const day = '2026-11-24';
  const t = publishTargetMinutes(day);
  const at = (m) => ({ day, minutes: m, hour: Math.floor(m / 60), minute: m % 60, isWeekday: true });
  const base = { publishedToday: false, hasApproved: true };
  assert.equal(publishDecision({ ...base, now: at(t - 30) }).action, 'skip');
  assert.deepEqual(publishDecision({ ...base, now: at(t - 3) }), { action: 'publish', waitSec: 180 });
  assert.deepEqual(publishDecision({ ...base, now: at(t - 5) }), { action: 'skip' });
  assert.deepEqual(publishDecision({ ...base, now: at(t) }), { action: 'publish', waitSec: 0 });
  assert.deepEqual(publishDecision({ ...base, now: at(t + 40) }), { action: 'publish', waitSec: 0 }); // догоняем
  assert.equal(publishDecision({ ...base, now: at(14 * 60 + 5) }).action, 'skip'); // поздно
  assert.equal(publishDecision({ ...base, publishedToday: true, now: at(t) }).action, 'skip');
  assert.equal(publishDecision({ ...base, hasApproved: false, now: at(t) }).action, 'skip');
  assert.deepEqual(publishDecision({ ...base, now: { ...at(t), isWeekday: false } }), { action: 'publish', waitSec: 0 }); // выходные тоже
});

const sampleHtml = `
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="cpa_lenta/9618">
<div class="tgme_widget_message_text js-message_text" dir="auto">«Мы продолжим выплаты» &amp; CEO ABCard Greg — о ситуации с Guava, возврате средств клиентам и развитии сервиса.<br/><br/>Собрали ответы на популярные вопросы клиентов и партнёров ABCard в Q/A статье. Много деталей&#33;</div>
<a class="tgme_widget_message_date" href="#"><time datetime="2026-11-24T09:00:00+00:00" class="time">09:00</time></a></div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="cpa_lenta/9000">
<div class="tgme_widget_message_text js-message_text" dir="auto">Старый пост, который давно вышел и должен отфильтроваться по возрасту, потому что ему больше двух суток и он нам не нужен совсем.</div>
<time datetime="2026-11-01T09:00:00+00:00"></time></div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="cpa_lenta/9619">
<div class="tgme_widget_message_text js-message_text" dir="auto">Коротко</div>
<time datetime="2026-11-24T10:00:00+00:00"></time></div></div>`;

test('parseTelegramChannel', () => {
  const now = new Date('2026-11-24T12:00:00Z').getTime();
  const posts = parseTelegramChannel(sampleHtml, { now });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://t.me/cpa_lenta/9618');
  assert.match(posts[0].text, /& CEO/);
  assert.match(posts[0].text, /\n\nСобрали/);
  assert.match(posts[0].text, /деталей!$/);
  const none = parseTelegramChannel(sampleHtml, { now, usedUrls: new Set(['https://t.me/cpa_lenta/9618']) });
  assert.equal(none.length, 0);
});

test('buildDigest сортирует и режет', () => {
  const posts = Array.from({ length: 40 }, (_, i) => ({ url: `u${i}`, date: new Date(2026, 0, 1, 0, i).toISOString(), text: 't' }));
  const { count, digest } = buildDigest(posts, 30);
  assert.equal(count, 30);
  assert.ok(digest.startsWith('[1] u39'));
});

test('parseAiJson', () => {
  const d = parseAiJson('```json\n{"topic":"x","source_url":"u","uk":"a","ru":"b","en":"c"}\n```');
  assert.equal(d.ru, 'b');
  assert.throws(() => parseAiJson('{"uk":"a","ru":"b"}'), /en/);
  assert.throws(() => parseAiJson('нет json'), /JSON/);
});

test('toLinkedInCommentary экранирует и делает хэштеги', () => {
  const out = toLinkedInCommentary('Цена (CPM) выросла @meta_ads *sale*\n\n#MediaBuying #FacebookAds');
  assert.equal(out, 'Цена \\(CPM\\) выросла \\@meta\\_ads \\*sale\\*\n\n{hashtag|\\#|MediaBuying} {hashtag|\\#|FacebookAds}');
});

test('linkedInVersions', () => {
  const v = linkedInVersions(new Date('2026-02-10T00:00:00Z'), 4);
  assert.deepEqual(v, ['202602', '202601', '202512', '202511']);
});

test('pickFormat: все форматы достижимы', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(pickFormat(i / 1000));
  assert.equal(seen.size, 7);
  assert.equal(pickFormat(0), 'короткая реакция');
  assert.equal(pickFormat(0.9999), 'совет');
});

test('pickLength: средняя чаще, короткая реакция всегда короткая', () => {
  const counts = {};
  for (let i = 0; i < 1000; i++) {
    const l = pickLength('опыт', i / 1000).name;
    counts[l] = (counts[l] || 0) + 1;
  }
  assert.ok(counts['средний'] > counts['короткий'] && counts['средний'] > counts['длинный']);
  assert.equal(pickLength('короткая реакция', 0.9).name, 'короткий');
});

test('postEdges: первая строка и концовка без хэштегов', () => {
  const e = postEdges('Заход тут 👀\n\nСередина\n\nВывод: концовка 🌪️\n\n#MediaBuying #iGaming');
  assert.deepEqual(e, { first: 'Заход тут 👀', last: 'Вывод: концовка 🌪️' });
  assert.equal(postEdges('#OnlyTags'), null);
});

test('buildUserPrompt: формат, длина и недавние посты', () => {
  const p = buildUserPrompt('ирония', 'DIGEST', {
    length: { name: 'длинный', range: '600–900' },
    recent: [{ first: 'A', last: 'B' }],
  });
  assert.match(p, /Формат этого поста: ирония/);
  assert.match(p, /Длина: длинный, 600–900/);
  assert.match(p, /Заход: «A» \/ Концовка: «B»/);
  assert.match(p, /DIGEST$/);
  assert.doesNotMatch(buildUserPrompt('опыт', 'D'), /Недавние/);
});
