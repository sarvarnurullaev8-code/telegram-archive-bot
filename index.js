
'use strict';

const path = require('path');
const AdmZip = require('adm-zip');
const unrar = require('node-unrar-js');

const TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.TELEGRAM_TOKEN ||
  process.env.TOKEN;

if (!TOKEN) {
  console.error('Bot token topilmadi!');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

const MB = 1024 * 1024;

// 256 MB RAM uchun ehtiyotkor limitlar
const MAX_FILE = 10 * MB;
const MAX_TOTAL = 20 * MB;
const MAX_FILES = 15;
const MAX_SESSIONS = 5;
const SESSION_TIMEOUT = 10 * 60 * 1000;

const sessions = new Map();
let offset = 0;

function cleanName(name) {
  return path
    .basename(String(name || 'file').replace(/\\/g, '/'))
    .replace(/[\x00-\x1f]/g, '_')
    .slice(0, 100) || 'file';
}

function safeEntry(name) {
  const normalized = String(name).replace(/\\/g, '/');
  const parts = normalized.split('/');

  return (
    !normalized.startsWith('/') &&
    !parts.includes('..') &&
    !parts.includes('') &&
    !/^[A-Za-z]:/.test(normalized)
  );
}

function uniqueName(files, filename) {
  const used = new Set(files.map(f => f.name));
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  let name = filename;
  let i = 2;

  while (used.has(name)) {
    name = `${base}_${i++}${ext}`;
  }

  return name;
}

async function telegram(method, payload) {
  const response = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000)
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      data.description || `Telegram error ${response.status}`
    );
  }

  return data.result;
}

async function say(chatId, text) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text
  });
}

async function sendFile(chatId, buffer, name) {
  if (buffer.length > MAX_FILE) {
    throw new Error('Yuboriladigan fayl 10 MB dan katta.');
  }

  const form = new FormData();

  form.append('chat_id', String(chatId));
  form.append(
    'document',
    new Blob([buffer]),
    cleanName(name)
  );

  const response = await fetch(`${API}/sendDocument`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60000)
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      data.description || 'Faylni yuborib bo‘lmadi.'
    );
  }

  return data.result;
}

async function download(fileId, expectedSize) {
  if (expectedSize > MAX_FILE) {
    throw new Error('10 MB dan kichik fayl yuboring.');
  }

  const info = await telegram('getFile', {
    file_id: fileId
  });

  if (!info.file_path) {
    throw new Error('Fayl manzili topilmadi.');
  }

  const response = await fetch(
    `${FILE_API}/${info.file_path}`,
    { signal: AbortSignal.timeout(60000) }
  );

  if (!response.ok || !response.body) {
    throw new Error('Fayl yuklanmadi.');
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of response.body) {
    total += chunk.length;

    if (total > MAX_FILE) {
      await response.body.cancel().catch(() => {});
      throw new Error('Fayl 10 MB limitdan oshdi.');
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

// ZIP arxivlarni ochish
function unpackZip(buffer) {
  const zip = new AdmZip(buffer);

  const entries = zip.getEntries().filter(
    entry => !entry.isDirectory
  );

  if (!entries.length) {
    throw new Error('ZIP arxiv bo‘sh.');
  }

  if (entries.length > MAX_FILES) {
    throw new Error('Arxivda 15 tadan ko‘p fayl bor.');
  }

  const total = entries.reduce(
    (sum, entry) => sum + Number(entry.header.size || 0),
    0
  );

  if (total > MAX_TOTAL) {
    throw new Error('Arxivdagi fayllar 20 MB dan katta.');
  }

  const files = [];

  for (const entry of entries) {
    if (!safeEntry(entry.entryName)) continue;

    if (entry.header.size > MAX_FILE) {
      throw new Error('Arxivdagi fayl 10 MB dan katta.');
    }

    const content = entry.getData();

    if (content.length > MAX_FILE) {
      throw new Error('Fayl 10 MB dan katta.');
    }

    const name = uniqueName(
      files,
      cleanName(entry.entryName)
    );

    files.push({ name, content });
  }

  return files;
}

// RAR arxivlarni ochish
async function unpackRar(buffer) {
  const data = Uint8Array.from(buffer);

  const extractor = await unrar.createExtractorFromData({
    data: data.buffer
  });

  const headers = [
    ...extractor.getFileList().fileHeaders
  ].filter(h => !h.flags.directory);

  if (!headers.length) {
    throw new Error('RAR arxiv bo‘sh.');
  }

  if (headers.length > MAX_FILES) {
    throw new Error('RAR ichida 15 tadan ko‘p fayl bor.');
  }

  const total = headers.reduce(
    (sum, h) => sum + Number(h.unpSize || 0),
    0
  );

  if (total > MAX_TOTAL) {
    throw new Error('RAR ichidagi fayllar 20 MB dan katta.');
  }

  const extracted = extractor.extract();
  const files = [];

  for (const item of extracted.files) {
    if (item.fileHeader.flags.directory) continue;

    if (!safeEntry(item.fileHeader.name)) continue;

    if (!item.extraction) continue;

    const content = Buffer.from(item.extraction);

    if (content.length > MAX_FILE) {
      throw new Error('RAR ichidagi fayl juda katta.');
    }

    const name = uniqueName(
      files,
      cleanName(item.fileHeader.name)
    );

    files.push({ name, content });
  }

  return files;
}

// Xotirani avtomatik tozalash
setInterval(() => {
  const now = Date.now();

  for (const [chatId, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      sessions.delete(chatId);
      console.log(`Session cleaned: ${chatId}`);
    }
  }
}, 60 * 1000).unref();

async function handle(message) {
  const chatId = message.chat?.id;
  if (!chatId) return;

  const command = (message.text || '')
    .split(' ')[0]
    .split('@')[0]
    .toLowerCase();

  const existing = sessions.get(chatId);

  if (existing) {
    existing.lastActivity = Date.now();
  }

  if (command === '/start' || command === '/help') {
    return say(
      chatId,
      '📦 Archive Bot\n\n' +
      '📸 Rasmlar yuboring\n' +
      '📄 Fayllar yuboring\n' +
      '📁 ZIP yoki RAR yuboring\n\n' +
      'Rasm va fayllarni ZIP qilish uchun:\n' +
      '1. Fayllarni yuboring\n' +
      '2. /done bosing\n' +
      '3. Tayyor ZIPni oling\n\n' +
      'ZIP/RAR yuborsangiz ichidagi fayllarni qaytaraman.\n\n' +
      '/done — ZIP yaratish\n' +
      '/cancel — tozalash\n' +
      '/status — xotira holati\n\n' +
      'Limit: 10 MB/fayl, 15 ta fayl, 20 MB jami.'
    );
  }

  if (command === '/cancel') {
    sessions.delete(chatId);

    return say(chatId, '🗑 Fayllar tozalandi.');
  }

  if (command === '/status') {
    const session = sessions.get(chatId);

    const count = session?.files.length || 0;
    const size = (session?.total || 0) / MB;

    return say(
      chatId,
      `📊 Sessiya holati\n\n` +
      `Fayllar: ${count}/${MAX_FILES}\n` +
      `Hajm: ${size.toFixed(2)} MB / 20 MB\n\n` +
      `10 daqiqa faolsizlikdan keyin fayllar tozalanadi.`
    );
  }

  if (command === '/done') {
    const session = sessions.get(chatId);

    if (!session || !session.files.length) {
      return say(chatId, 'Avval rasm yoki fayl yuboring.');
    }

    await say(chatId, '📦 ZIP tayyorlanyapti...');

    const zip = new AdmZip();

    for (const file of session.files) {
      zip.addFile(file.name, file.content);
    }

    const result = zip.toBuffer();

    if (result.length > MAX_FILE) {
      throw new Error(
        'Tayyor ZIP 10 MB dan katta. /cancel bosib, kamroq fayl yuboring.'
      );
    }

    await sendFile(chatId, result, 'archive.zip');

    sessions.delete(chatId);

    return say(
      chatId,
      '✅ ZIP tayyor! Xotira tozalandi.'
    );
  }

  const doc = message.document;

  const photo = !doc && Array.isArray(message.photo)
    ? message.photo[message.photo.length - 1]
    : null;

  if (!doc && !photo) return;

  const filename = doc
    ? cleanName(doc.file_name || 'document')
    : `photo_${message.message_id}.jpg`;

  const lower = filename.toLowerCase();
  const isZip = lower.endsWith('.zip');
  const isRar = lower.endsWith('.rar');

  const source = doc || photo;

  if (
    !isZip &&
    !isRar &&
    !sessions.has(chatId) &&
    sessions.size >= MAX_SESSIONS
  ) {
    throw new Error(
      'Bot hozir band. Birozdan keyin urinib ko‘ring.'
    );
  }

  if (!isZip && !isRar) {
    const current = sessions.get(chatId);

    if (current?.files.length >= MAX_FILES) {
      throw new Error(
        '15 ta fayl limiti. /done yoki /cancel bosing.'
      );
    }

    if (
      current &&
      current.total + (source.file_size || 0) > MAX_TOTAL
    ) {
      throw new Error(
        '20 MB limit. /done yoki /cancel bosing.'
      );
    }
  }

  const buffer = await download(
    source.file_id,
    source.file_size || 0
  );

  if (isZip || isRar) {
    await say(chatId, '📂 Arxiv ochilyapti...');

    const files = isZip
      ? unpackZip(buffer)
      : await unpackRar(buffer);

    if (!files.length) {
      return say(chatId, 'Arxivda mos fayllar topilmadi.');
    }

    let count = 0;

    for (const file of files) {
      await sendFile(chatId, file.content, file.name);
      count++;
    }

    return say(
      chatId,
      `✅ ${count} ta fayl yuborildi.`
    );
  }

  let session = sessions.get(chatId);

  if (!session) {
    session = {
      files: [],
      total: 0,
      lastActivity: Date.now()
    };

    sessions.set(chatId, session);
  }

  if (session.files.length >= MAX_FILES) {
    throw new Error('15 ta fayl limiti.');
  }

  if (session.total + buffer.length > MAX_TOTAL) {
    throw new Error('20 MB limitdan oshdi.');
  }

  const name = uniqueName(session.files, filename);

  session.files.push({
    name,
    content: buffer
  });

  session.total += buffer.length;
  session.lastActivity = Date.now();

  return say(
    chatId,
    `✅ ${name} qabul qilindi.\n` +
    `Jami: ${session.files.length} ta fayl.\n\n` +
    `ZIP olish uchun /done bosing.`
  );
}

async function main() {
  console.log('Archive Bot starting...');

  await telegram('deleteWebhook', {
    drop_pending_updates: false
  });

  console.log('Archive Bot running!');

  while (true) {
    try {
      const updates = await telegram('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message']
      });

      for (const update of updates) {
        offset = update.update_id + 1;

        try {
          await handle(update.message || {});
        } catch (error) {
          console.error('Error:', error);

          const chatId = update.message?.chat?.id;

          if (chatId) {
            await say(
              chatId,
              `❌ ${error.message || 'Xatolik yuz berdi.'}`
            ).catch(() => {});
          }
        }
      }
    } catch (error) {
      console.error('Polling error:', error.message);

      await new Promise(resolve =>
        setTimeout(resolve, 3000)
      );
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
