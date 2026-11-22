'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const unrar = require('node-unrar-js');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TELEGRAM_TOKEN || process.env.TOKEN;
if (!TOKEN) { console.error('Missing TELEGRAM_BOT_TOKEN'); process.exit(1); }
const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;
const ROOT = path.join(os.tmpdir(), 'telegram-archive-bot');
const MAX_INPUT = 15 * 1024 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;
const MAX_FILES = 25;
const sessions = new Map();
let offset = 0;

function cleanName(s) {
  return path.basename(String(s || 'file').replaceAll('\\', '/')).replace(/[\x00-\x1f]/g, '_').slice(0, 100) || 'file';
}
function safeEntry(s) {
  const parts = String(s).replaceAll('\\', '/').split('/');
  return !parts.some(p => p === '..' || p === '') && !String(s).startsWith('/');
}
async function telegram(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data.result;
}
async function say(chat_id, text) { return telegram('sendMessage',{chat_id,text}); }
async function sendFile(chat_id, buffer, name) {
  const form = new FormData();
  form.append('chat_id', String(chat_id));
  form.append('document', new Blob([buffer]), cleanName(name));
  const res = await fetch(`${API}/sendDocument`, {method:'POST',body:form});
  const result = await res.json();
  if (!result.ok) throw new Error(`sendDocument: ${result.description || res.status}`);
}
async function download(file_id, expectedSize) {
  if (expectedSize > MAX_INPUT) throw new Error('Fayl juda katta. 15 MB gacha yuboring.');
  const info = await telegram('getFile',{file_id});
  if (!info.file_path) throw new Error('Telegram fayl manzilini qaytarmadi.');
  const res = await fetch(`${FILE_API}/${info.file_path}`);
  if (!res.ok) throw new Error('Faylni yuklab bo‘lmadi.');
  const chunks = []; let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_INPUT) { await res.body.cancel().catch(()=>{}); throw new Error('15 MB limitdan oshdi.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function unpackZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter(e => !e.isDirectory);
  if (!entries.length) throw new Error('Arxiv ichida fayl yo‘q.');
  if (entries.length > MAX_FILES) throw new Error(`Arxivda ${MAX_FILES} tadan ko‘p fayl bor.`);
  const total = entries.reduce((sum,e)=>sum+Number(e.header.size || 0),0);
  if (total > MAX_TOTAL) throw new Error('Ochilgan fayllar hajmi 40 MB dan oshadi.');
  const out = [];
  for (const e of entries) {
    if (!safeEntry(e.entryName)) continue;
    const content = e.getData();
    if (content.length > MAX_INPUT) throw new Error('Arxivdagi bitta fayl 15 MB dan katta.');
    out.push({name:cleanName(e.entryName),content});
  }
  return out;
}
async function unpackRar(buffer) {
  const extractor = await unrar.createExtractorFromData({data:Uint8Array.from(buffer).buffer});
  const listed = [...extractor.getFileList().fileHeaders].filter(h => !h.flags.directory);
  if (!listed.length) throw new Error('Arxiv ichida fayl yo‘q.');
  if (listed.length > MAX_FILES) throw new Error(`Arxivda ${MAX_FILES} tadan ko‘p fayl bor.`);
  if (listed.reduce((a,h)=>a+Number(h.unpSize||0),0)>MAX_TOTAL) throw new Error('Arxiv ichidagi fayllar 40 MB dan katta.');
  const out = [];
  for (const f of extractor.extract().files) {
    if (f.fileHeader.flags.directory || !safeEntry(f.fileHeader.name) || !f.extraction) continue;
    if (f.extraction.byteLength > MAX_INPUT) throw new Error('Arxivdagi bitta fayl 15 MB dan katta.');
    out.push({name:cleanName(f.fileHeader.name),content:Buffer.from(f.extraction)});
  }
  return out;
}
function uniqueName(existing, filename) {
  const ext = path.extname(filename), base = path.basename(filename,ext);
  let candidate = filename, i=2;
  while (existing.has(candidate)) candidate = `${base}_${i++}${ext}`;
  return candidate;
}
async function handle(msg) {
  const chat = msg.chat?.id;
  if (!chat) return;
  const command = (msg.text || '').split(' ')[0].split('@')[0].toLowerCase();
  if (command === '/start' || command === '/help') {
    return say(chat,'📦 Archive Bot\n\nZIP yoki RAR yuboring — ichidagi fayllarni qaytaraman.\n\nBir nechta oddiy fayl yuboring, keyin /done yozing — ZIP qilib beraman.\n\n/cancel — yig‘ilgan fayllarni tozalaydi.\n\nLimit: 15 MB/fayl, 25 fayl, 40 MB jami.\nRAR yaratish hozircha yo‘q.');
  }
  if (command === '/cancel') { sessions.delete(chat); return say(chat,'🗑 Yig‘ilgan fayllar tozalandi.'); }
  if (command === '/done') {
    const session = sessions.get(chat);
    if (!session?.files?.length) return say(chat,'Avval menga fayllar yuboring.');
    const zip = new AdmZip();
    for (const file of session.files) zip.addFile(file.name,file.content);
    const result = zip.toBuffer();
    if (result.length > 45*1024*1024) throw new Error('ZIP juda katta. Kichikroq fayllardan foydalaning.');
    await sendFile(chat,result,'files.zip');
    sessions.delete(chat);
    return say(chat,'✅ ZIP tayyor!');
  }
  const doc = msg.document;
  if (!doc) return;
  const filename = cleanName(doc.file_name || 'file');
  const lower = filename.toLowerCase();
  const isArchive = lower.endsWith('.zip') || lower.endsWith('.rar');
  const buffer = await download(doc.file_id,doc.file_size || 0);
  if (isArchive) {
    await say(chat,'📂 Arxiv ochilyapti...');
    const items = lower.endsWith('.zip') ? unpackZip(buffer) : await unpackRar(buffer);
    if (!items.length) return say(chat,'Arxiv ichida yuborish mumkin bo‘lgan fayllar topilmadi.');
    let sent = 0;
    for (const f of items) { await sendFile(chat,f.content,f.name); sent++; }
    return say(chat,`✅ ${sent} ta fayl yuborildi.`);
  }
  let session = sessions.get(chat);
  if (!session) {session={files:[],total:0};sessions.set(chat,session);}
  if (session.files.length >= MAX_FILES) throw new Error('25 ta fayl limiti. /done yoki /cancel bosing.');
  if (session.total + buffer.length > MAX_TOTAL) throw new Error('Jami 40 MB limit. /done yoki /cancel bosing.');
  const used = new Set(session.files.map(f=>f.name));
  const name = uniqueName(used,filename);
  session.files.push({name,content:buffer}); session.total += buffer.length;
  return say(chat,`✅ ${name} qabul qilindi (${session.files.length} ta). ZIP olish uchun /done yozing.`);
}
async function main() {
  await fsp.mkdir(ROOT,{recursive:true});
  console.log('Archive bot starting...');
  await telegram('deleteWebhook',{drop_pending_updates:false});
  while (true) {
    try {
      const updates = await telegram('getUpdates',{offset,timeout:25,allowed_updates:['message']});
      for (const upd of updates) {
        offset = upd.update_id + 1;
        try { await handle(upd.message || {}); }
        catch (e) {
          console.error('Message failed:',e.message);
          const chat = upd.message?.chat?.id;
          if (chat) await say(chat,`❌ ${e.message || 'Xatolik yuz berdi.'}`).catch(()=>{});
        }
      }
    } catch (e) {
      console.error('Polling error:',e.message);
      await new Promise(resolve=>setTimeout(resolve,3000));
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
