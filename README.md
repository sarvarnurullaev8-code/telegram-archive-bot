# Telegram Archive Bot — FadeHost

ZIP va RAR fayllarni ochadi, ichidagi fayllarni Telegram orqali qaytaradi. Oddiy fayllarni ZIP qiladi.

## GitHub orqali joylash
1. ZIP'ni kompyuterda oching.
2. GitHub'dagi `telegram-archive-bot` repository sahifasiga o'ting.
3. `Add file` → `Upload files` ni bosing (bo'sh repo bo'lsa `uploading an existing file`).
4. `index.js`, `package.json`, `README.md`, `.gitignore` fayllarini yuklang. ZIP'ning o'zini emas!
5. `Commit changes` ni bosing.
6. FadeHost'da mavjud bot → `Settings` → GitHub repository/repository source → repository URL'ni `https://github.com/sarvarnurullaev8-code/telegram-archive-bot` ga almashtiring. Start command: `npm start`, branch `main`.
7. Telegram tokeni avvalgi botdan environment variable sifatida qolishi kerak. `TELEGRAM_BOT_TOKEN` ni tekshiring. Tokenni hech qachon GitHub'ga joylamang.
8. `Redeploy (pull latest)` ni bosing va loglarni ko'ring.
9. Telegramda `/start` yozib sinang.

## Buyruqlar
- `/start` — yo'riqnoma
- ZIP/RAR hujjat yuborish — fayllarni ajratib qaytaradi
- Boshqa bir nechta hujjat yuborish → `/done` — files.zip
- `/cancel` — kutayotgan fayllarni bekor qiladi

## Cheklovlar
- Bir fayl 15MB gacha, jami 40MB, 25 fayl.
- Bepul hosting 256MB RAM: juda katta RAR yoki ZIP fayllar bilan ishlamaydi.
- Parolli va ko'p jildli RAR qo'llab-quvvatlanmaydi.
- RAR arxiv yaratish qo'llab-quvvatlanmaydi, faqat ochish mumkin.
- Bot sessiyalari server qayta ishga tushsa yo'qoladi.
- Bu dastlabki versiya: sinovdan o'tkazish zarur.
