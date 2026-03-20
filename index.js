/**
 * Telegram bot (ESM): send a ZIP with images -> get back a ZIP with captions.
 * - Auto-resize: max side = 368 px (keeps aspect ratio, no upscaling) for faster CPU inference.
 * Requirements:
 *   - Ollama running locally (http://127.0.0.1:11434)
 *   - Model pulled: `ollama pull qwen3.5:2b`
 *   - Optional local config in `.env`
 *
 * Run:
 *   node index.js
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import TelegramBot from 'node-telegram-bot-api';
import AdmZip from 'adm-zip';
import archiver from 'archiver';
import pLimit from 'p-limit';
import { Ollama } from 'ollama';
import sharp from 'sharp';

// __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === Config ===
const BOT_TOKEN = process.env.BOT_TOKEN || 'PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:2b';
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11434);
const CONCURRENCY = Number(process.env.CAPTION_CONCURRENCY || 1);
const RESIZE_ENABLED = process.env.RESIZE_ENABLED ? process.env.RESIZE_ENABLED !== '0' : true;
const RESIZE_MAX = Number(process.env.RESIZE_MAX || 368);
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 60000);

// Reasoning on/off (default: off)
const THINK_ENABLED = process.env.THINK_ENABLED ? process.env.THINK_ENABLED !== '0' : false;

const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);

// Short, strict prompt
const CAPTION_PROMPT = [
  'Write a single short (up to 50 words) English description of the image contents.',
  'Be strictly factual and concise. No guesses.',
  'Describe key objects and attributes, style-neutral.',
  'Do not write any camera-related descriptions and phrases like "a photo of" or "The image shows".'
].join(' ');
const ollama = new Ollama({ host: `http://${OLLAMA_HOST}:${OLLAMA_PORT}` });

// === Bot init ===
if (!BOT_TOKEN || BOT_TOKEN.includes('PUT_YOUR')) {
  console.error('❌ Set BOT_TOKEN env var (BOT_TOKEN=123:ABC).');
  process.exit(1);
}
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Hi! Send me a ZIP with images. I will caption each image using Ollama (${OLLAMA_MODEL}) and send back a ZIP with .txt captions.\nAuto-resize: max side ${RESIZE_MAX}px for faster processing.`
  );
});

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const doc = msg.document;

  // If the user adds a ZIP caption, append it to the base caption prompt.
  const userCaption = (msg.caption || '').trim();
  const effectivePrompt = userCaption ? CAPTION_PROMPT + ' ' + userCaption : CAPTION_PROMPT;

  const isZip =
    (doc.mime_type && doc.mime_type.includes('zip')) ||
    (doc.file_name && doc.file_name.toLowerCase().endsWith('.zip'));

  if (!isZip) {
    await bot.sendMessage(chatId, 'Please send a ZIP archive with images.');
    return;
  }

  const notice = await bot.sendMessage(chatId, 'Got the archive. Processing…');

  const workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'tg-ollama-'));
  const zipPath = path.join(workRoot, sanitizeFilename(doc.file_name || 'images.zip'));
  const extractDir = path.join(workRoot, 'extracted');
  const resizedDir = path.join(workRoot, 'resized');
  const captionsDir = path.join(workRoot, 'captions');

  await fsp.mkdir(extractDir, { recursive: true });
  await fsp.mkdir(resizedDir, { recursive: true });
  await fsp.mkdir(captionsDir, { recursive: true });

  try {
    await downloadTelegramFile(bot, doc.file_id, zipPath);

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractDir, true);

    const imageFiles = await walkImages(extractDir);
    if (imageFiles.length === 0) {
      await bot.editMessageText('No images found in the archive.', {
        chat_id: chatId,
        message_id: notice.message_id
      });
      await cleanup(workRoot);
      return;
    }

    const limit = pLimit(CONCURRENCY);
    let done = 0;

    for (let i = 0; i < imageFiles.length; i++) {
      const absPath = imageFiles[i];

      let retries = 0;
      let success = false;

      while (!success && retries < 3) {

        try {

          // Resize the image and get the prepared file path.
          const preparedPath = RESIZE_ENABLED
            ? await prepareImage(absPath, extractDir, resizedDir, RESIZE_MAX)
            : absPath;

          const caption = await captionImage(preparedPath, effectivePrompt);

          const rel = path.relative(extractDir, absPath);
          const relNoExt = rel.replace(path.extname(rel), '');
          const outPath = path.join(captionsDir, relNoExt + '.txt');
          await fsp.mkdir(path.dirname(outPath), { recursive: true });
          // Replace unwanted text and symbols. TODO: move this to configuration.
          const capt1 = caption.trim().replace('The image shows ', '').replace(/\u2018|\u2019|\u02BC|\u0092/g, "'");
          const capt = capt1[0].toUpperCase() + capt1.slice(1);
          await fsp.writeFile(outPath, capt + '\n', 'utf8');

          done += 1;
          console.log(`Processing… ${done}/${imageFiles.length} images\n\n${capt}`);

          await bot.editMessageText(`Processing… ${done}/${imageFiles.length} images\n\n${capt}`, {
            chat_id: chatId,
            message_id: notice.message_id
          });

          success = true;

          break;

        } catch (e) {
          console.log(`Error while processing image: ${e.message}`);
          retries++;
        }
      }
    }

    const resultZipPath = path.join(workRoot, 'captions.zip');
    await zipDirectory(captionsDir, resultZipPath);

    await bot.sendDocument(chatId, resultZipPath, {}, {
      filename: 'captions.zip',
      contentType: 'application/zip'
    });

    await bot.editMessageText('Done ✅', {
      chat_id: chatId,
      message_id: notice.message_id
    });
  } catch (err) {
    console.error(err);
    await bot.editMessageText('Error while processing the archive.', {
      chat_id: chatId,
      message_id: notice.message_id
    });
  } finally {
    await cleanup(workRoot);
  }
});

// === Helpers ===

function sanitizeFilename(name) {
  return name.replace(/[^\w.\-()+ ]+/g, '_');
}

async function downloadTelegramFile(botInstance, fileId, destPath) {
  const dir = path.dirname(destPath);
  await fsp.mkdir(dir, { recursive: true });
  const savedPath = await botInstance.downloadFile(fileId, dir);
  if (savedPath !== destPath) {
    await fsp.rename(savedPath, destPath);
  }
}

async function walkImages(root) {
  const out = [];
  async function rec(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await rec(p);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (SUPPORTED_EXT.has(ext)) out.push(p);
      }
    }
  }
  await rec(root);
  return out;
}

/**
 * Creates a resized image in `resizedDir`.
 * - max(width, height) = maxSize
 * - keep aspect ratio
 * - do not upscale
 * Returns the prepared file path, or the original file if resizing fails.
 */
async function prepareImage(absPath, extractDir, resizedDir, maxSize) {
  try {
    const rel = path.relative(extractDir, absPath);
    const outPath = path.join(resizedDir, rel);
    await fsp.mkdir(path.dirname(outPath), { recursive: true });

    const img = sharp(absPath, { unlimited: false });
    const meta = await img.metadata();

    // If the image is already smaller than maxSize, copy it as-is.
    const needResize =
      (meta.width && meta.width > maxSize) || (meta.height && meta.height > maxSize);

    if (!needResize) {
      await fsp.copyFile(absPath, outPath);
      return outPath;
    }

    await img
      .resize({
        width: maxSize,
        height: maxSize,
        fit: 'inside',
        withoutEnlargement: true
      })
      .toFile(outPath);

    return outPath;
  } catch (e) {
    // If resizing fails, fall back to the original file.
    return absPath;
  }
}


// Stream the model response to stdout in chunks.
async function captionImage(imagePath, prompt) {
  console.log(`Processing image: ${imagePath}`);

  const tm = setTimeout(() => {
    console.log('\nAborting request...\n')
    ollama.abort()
  }, OLLAMA_TIMEOUT_MS);

  const stream = await ollama.chat({
    model: OLLAMA_MODEL,
    messages: [{ role: 'user', content: prompt, images: [imagePath] }],
    stream: true,
    keep_alive: '24h',
    think: THINK_ENABLED,
    options: { temperature: 0.2 }
  });

  let text = '';
  for await (const part of stream) {
    const chunk = part?.message?.content || '';
    if (chunk) {
      process.stdout.write(chunk);   // Stream output
      text += chunk;                 // Accumulate the result
    }
  }
  process.stdout.write('\n');        // New line after the response

  clearTimeout(tm);

  return cleanCaption(text);
}

function cleanCaption(s) {
  let t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/\s+/g, ' ');
  return t;
}

async function zipDirectory(srcDir, outZip) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

async function cleanup(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch { }
}

// /ping command for a quick Ollama health check
bot.onText(/\/ping/, async (msg) => {
  try {
    const id = crypto.randomBytes(4).toString('hex');
    await ollama.generate({ model: OLLAMA_MODEL, prompt: `ping ${id}` });
    bot.sendMessage(msg.chat.id, `Ollama OK (model: ${OLLAMA_MODEL})`);
  } catch (e) {
    bot.sendMessage(msg.chat.id, 'Ollama not responding. Is it running?');
  }
});
