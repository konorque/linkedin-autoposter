#!/usr/bin/env node
// Removes secrets from an n8n workflow export before committing it to Git.
// Usage: node scripts/sanitize-workflow.js path/to/exported.json [more.json ...]
// The file is overwritten in place.

const fs = require('fs');

const PLACEHOLDERS = {
  bot_token: 'YOUR_TELEGRAM_BOT_TOKEN',
  telegram_chat_id: 'YOUR_TELEGRAM_CHAT_ID',
  person_id: 'YOUR_LINKEDIN_PERSON_ID',
};

// Telegram bot tokens look like 123456789:AA... — catch them anywhere in the file
const TOKEN_RE = /\d{8,10}:[A-Za-z0-9_-]{30,}/g;

for (const file of process.argv.slice(2)) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));

  for (const node of wf.nodes || []) {
    delete node.credentials; // credential IDs are instance-specific
    const assignments = node.parameters?.assignments?.assignments || [];
    for (const a of assignments) {
      if (a.name in PLACEHOLDERS) a.value = PLACEHOLDERS[a.name];
    }
  }
  delete wf.id;
  delete wf.meta;
  delete wf.versionId;
  delete wf.pinData;

  let out = JSON.stringify(wf, null, 2);
  const leaks = out.match(TOKEN_RE);
  if (leaks) {
    out = out.replace(TOKEN_RE, PLACEHOLDERS.bot_token);
    console.warn(`${file}: replaced ${leaks.length} token-like string(s)`);
  }
  fs.writeFileSync(file, out + '\n');
  console.log(`${file}: sanitized`);
}
