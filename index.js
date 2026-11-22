
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const AdmZip = require('adm-zip');
const unrar = require('node-unrar-js');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ||
  process.env.BOT_TOKEN ||
  process.env.TELEGRAM_TOKEN ||
  process.env.TOKEN;

if (!TOKEN) {
  console.error('Missing Telegram bot token');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;
const ROOT = path.join(os.tmpdir(), 'telegram-archive-bot');
const CLEAN_INTERVAL = 20 * 60 * 1000;

const sessions = new Map();
const queues = new Map();
const modes = new Map();
let offset = 0;

const KEYBOARD = {
  keyboard: [
    [
      { text: '📦 Files to ZIP' },
      { text: '📂 ZIP/RAR to Files' }
    ],
    [
      { text: '✅ Create ZIP' },
      { text: '🗑 Clear Files' }
    ],
    [
      { text: '📊 Status' },
      { text: 'ℹ️ Help' }
    ]
  ],
  resize_keyboard: true,
  is_persistent: true
};

function safeName(value) {
  return path.basename(
    String(value || 'file').replace(/\\/g, '/')
  ).replace(/[\x00-\x1f]/g, '_').slice(0, 160) || 'file';
}

function uniqueName(used, original) {
  const base = safeName(original);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);

  let name = base;
  let i = 2;

  while (used.has(name)) {
    name = `${stem}_${i++}${ext}`;
  }

  used.add(name);
  return name;
}

async function callTelegram(method, payload) {
  const response = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json();

  if (!result.ok) {
    throw new Error(
      result.description || `Telegram ${method} failed`
    );
  }

  return result.result;
}

function say(chatId, text) {
  return callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: KEYBOARD
  });
}

async function download(fileId, destination) {
  const info = await callTelegram('getFile', {
    file_id: fileId
  });

  if (!info.file_path) {
    throw new Error(
      'Telegram did not return a file path.'
    );
  }

  const response = await fetch(
    `${FILE_API}/${info.file_path}`
  );

  if (!response.ok || !response.body) {
    throw new Error('Download failed.');
  }

  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(destination)
  );
}

async function sendDocument(chatId, filePath, displayName) {
  const content = await fsp.readFile(filePath);
  const form = new FormData();

  form.append('chat_id', String(chatId));

  form.append(
    'document',
    new Blob([content]),
    safeName(displayName)
  );

  const response = await fetch(`${API}/sendDocument`, {
    method: 'POST',
    body: form
  });

  const result = await response.json();

  if (!result.ok) {
    throw new Error(
      result.description || 'Upload failed.'
    );
  }
}

async function removeDir(dir) {
  if (dir) {
    await fsp.rm(dir, {
      recursive: true,
      force: true
    });
  }
}

async function clearFiles(chatId) {
  const session = sessions.get(chatId);
  sessions.delete(chatId);

  if (session) {
    await removeDir(session.dir);
  }
}

async function getSession(chatId) {
  let session = sessions.get(chatId);

  if (!session) {
    const dir = await fsp.mkdtemp(
      path.join(ROOT, 'pending-')
    );

    session = {
      dir,
      files: [],
      used: new Set(),
      createdAt: Date.now()
    };

    sessions.set(chatId, session);
  }

  return session;
}

async function addFile(chatId, fileId, filename) {
  const session = await getSession(chatId);

  const filenameSafe = uniqueName(
    session.used,
    filename
  );

  const filepath = path.join(
    session.dir,
    filenameSafe
  );

  try {
    await download(fileId, filepath);

    session.files.push({
      name: filenameSafe,
      filepath
    });
  } catch (error) {
    session.used.delete(filenameSafe);

    await fsp.rm(filepath, {
      force: true
    });

    throw error;
  }

  await say(
    chatId,
    `✅ Added: ${filenameSafe}\n` +
    `Files ready: ${session.files.length}\n` +
    `Tap ✅ Create ZIP when finished.`
  );
}

async function createZip(chatId) {
  const session = sessions.get(chatId);

  if (!session?.files.length) {
    return say(
      chatId,
      'No files yet. Send photos or documents first.'
    );
  }

  await say(
    chatId,
    '⏳ Creating your ZIP archive...'
  );

  const zip = new AdmZip();

  for (const file of session.files) {
    zip.addLocalFile(
      file.filepath,
      '',
      file.name
    );
  }

  const output = path.join(
    session.dir,
    'archive.zip'
  );

  await new Promise((resolve, reject) => {
    zip.writeZip(output, error => {
      if (error) reject(error);
      else resolve();
    });
  });

  await sendDocument(
    chatId,
    output,
    'archive.zip'
  );

  await clearFiles(chatId);

  await say(
    chatId,
    '✅ ZIP created and sent. Temporary files removed.'
  );
}

async function unpackZip(filepath, targetDir) {
  const zip = new AdmZip(filepath);
  const names = new Set();
  const files = [];

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;

    const name = uniqueName(
      names,
      entry.entryName
    );

    const output = path.join(
      targetDir,
      name
    );

    await fsp.writeFile(
      output,
      entry.getData()
    );

    files.push({
      name,
      filepath: output
    });
  }

  return files;
}

async function unpackRar(filepath, targetDir) {
  const bytes = await fsp.readFile(filepath);

  const extractor = await unrar.createExtractorFromData({
    data: Uint8Array.from(bytes).buffer
  });

  const names = new Set();
  const files = [];

  for (const item of extractor.extract().files) {
    if (
      item.fileHeader.flags.directory ||
      !item.extraction
    ) continue;

    const name = uniqueName(
      names,
      item.fileHeader.name
    );

    const output = path.join(
      targetDir,
      name
    );

    await fsp.writeFile(
      output,
      Buffer.from(item.extraction)
    );

    files.push({
      name,
      filepath: output
    });
  }

  return files;
}

async function extractArchive(
  chatId,
  fileId,
  filename
) {
  const workDir = await fsp.mkdtemp(
    path.join(ROOT, 'extract-')
  );

  try {
    await say(
      chatId,
      '⏳ Extracting archive...'
    );

    const source = path.join(
      workDir,
      `input${path.extname(filename).toLowerCase()}`
    );

    await download(fileId, source);

    const files = filename.toLowerCase().endsWith('.rar')
      ? await unpackRar(source, workDir)
      : await unpackZip(source, workDir);

    if (!files.length) {
      return say(
        chatId,
        'No files found in this archive.'
      );
    }

    for (const file of files) {
      await sendDocument(
        chatId,
        file.filepath,
        file.name
      );
    }

    await say(
      chatId,
      `✅ Extracted and sent ${files.length} file(s).`
    );
  } finally {
    await removeDir(workDir);
  }
}

async function status(chatId) {
  const session = sessions.get(chatId);

  if (!session) {
    return say(
      chatId,
      '📊 No temporary files stored.'
    );
  }

  let total = 0;

  for (const file of session.files) {
    try {
      total += (
        await fsp.stat(file.filepath)
      ).size;
    } catch (_) {}
  }

  return say(
    chatId,
    `📊 Files: ${session.files.length}\n` +
    `Stored size: ${(total / 1048576).toFixed(2)} MB\n` +
    `Temporary files are cleared every 20 minutes.`
  );
}

async function handle(message) {
  const chatId = message.chat?.id;
  if (!chatId) return;

  const input = (
    message.text || ''
  ).trim();

  const command = input
    .split(' ')[0]
    .split('@')[0]
    .toLowerCase();

  if (
    command === '/start' ||
    command === '/help' ||
    input === 'ℹ️ Help'
  ) {
    return say(
      chatId,
      '📦 Archive Bot\n\n' +
      '📦 Files to ZIP: Send photos or documents, then tap ✅ Create ZIP.\n' +
      '📂 ZIP/RAR to Files: Send a ZIP or RAR archive to extract it.\n' +
      '🗑 Clear Files: Delete your queued files.\n' +
      '📊 Status: Check your queued files.\n\n' +
      'Temporary files are cleared automatically every 20 minutes.\n' +
      'Telegram and hosting size limits still apply.'
    );
  }

  if (input === '📦 Files to ZIP') {
    modes.set(chatId, 'zip');

    return say(
      chatId,
      '📦 ZIP mode enabled. Send photos or files. Tap ✅ Create ZIP when ready.'
    );
  }

  if (input === '📂 ZIP/RAR to Files') {
    modes.set(chatId, 'extract');

    return say(
      chatId,
      '📂 Extraction mode enabled. Send a ZIP or RAR archive.'
    );
  }

  if (
    command === '/cancel' ||
    input === '🗑 Clear Files'
  ) {
    await clearFiles(chatId);

    return say(
      chatId,
      '🗑 Temporary files cleared.'
    );
  }

  if (
    command === '/status' ||
    input === '📊 Status'
  ) {
    return status(chatId);
  }

  if (
    command === '/done' ||
    input === '✅ Create ZIP'
  ) {
    return createZip(chatId);
  }

  const document = message.document;

  const photo = !document && message.photo?.length
    ? message.photo[message.photo.length - 1]
    : null;

  if (!document && !photo) return;

  const file = document || photo;

  const filename = document
    ? safeName(
        document.file_name ||
        `document_${message.message_id}`
      )
    : `photo_${message.message_id}.jpg`;

  const archive = /\.(zip|rar)$/i.test(filename);
  const mode = modes.get(chatId);

  if (mode === 'extract' && !archive) {
    return say(
      chatId,
      'Please send a ZIP or RAR archive, or choose 📦 Files to ZIP.'
    );
  }

  if (archive && mode !== 'zip') {
    return extractArchive(
      chatId,
      file.file_id,
      filename
    );
  }

  return addFile(
    chatId,
    file.file_id,
    filename
  );
}

function enqueue(chatId, task) {
  const previous =
    queues.get(chatId) || Promise.resolve();

  const current = previous
    .catch(() => {})
    .then(task);

  queues.set(chatId, current);

  current.finally(() => {
    if (queues.get(chatId) === current) {
      queues.delete(chatId);
    }
  }).catch(() => {});
}

// Automatically clean temporary files every 20 minutes
setInterval(async () => {
  for (const chatId of sessions.keys()) {
    if (queues.has(chatId)) continue;

    try {
      await clearFiles(chatId);
    } catch (error) {
      console.error(
        'Cleanup error:',
        error.message
      );
    }
  }
}, CLEAN_INTERVAL).unref();

async function main() {
  await fsp.mkdir(ROOT, {
    recursive: true
  });

  // Clean leftover files after restart
  for (const name of await fsp.readdir(ROOT)) {
    await removeDir(
      path.join(ROOT, name)
    );
  }

  await callTelegram('deleteWebhook', {
    drop_pending_updates: false
  });

  console.log('Archive Bot is running.');

  while (true) {
    try {
      const updates = await callTelegram(
        'getUpdates',
        {
          offset,
          timeout: 25,
          allowed_updates: ['message']
        }
      );

      for (const update of updates) {
        offset = update.update_id + 1;

        const message = update.message;

        if (!message?.chat?.id) continue;

        enqueue(
          message.chat.id,
          async () => {
            try {
              await handle(message);
            } catch (error) {
              console.error(
                'Message error:',
                error
              );

              await say(
                message.chat.id,
                `❌ ${error.message || 'Something went wrong.'}`
              ).catch(() => {});
            }
          }
        );
      }
    } catch (error) {
      console.error(
        'Polling error:',
        error.message
      );

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

