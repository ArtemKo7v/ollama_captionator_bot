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
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:2b';
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 11434);
const ALLOWED_TELEGRAM_USER_IDS = parseAllowedUserIds(process.env.ALLOWED_TELEGRAM_USER_IDS || '');
const CONCURRENCY = Number(process.env.CAPTION_CONCURRENCY || 1);
const RESIZE_ENABLED = process.env.RESIZE_ENABLED ? process.env.RESIZE_ENABLED !== '0' : true;
const RESIZE_MAX = Number(process.env.RESIZE_MAX || 368);
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 60000);

// Reasoning on/off (default: off)
const THINK_ENABLED = process.env.THINK_ENABLED ? process.env.THINK_ENABLED !== '0' : false;

const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);

// Short, strict prompt
const DEFAULT_CAPTION_PROMPT = [
  'Write a single short (up to 50 words) English description of the image contents.',
  'Be strictly factual and concise. No guesses.',
  'Describe key objects and attributes, style-neutral.',
  'Do not write any camera-related descriptions and phrases like "a photo of" or "The image shows".'
].join(' ');

let CAPTION_PROMPT = process.env.CAPTION_PROMPT || DEFAULT_CAPTION_PROMPT;
let CURRENT_OLLAMA_MODEL = DEFAULT_OLLAMA_MODEL;

const ollama = new Ollama({ host: `http://${OLLAMA_HOST}:${OLLAMA_PORT}` });

// === Bot init ===
if (!BOT_TOKEN || BOT_TOKEN.includes('PUT_YOUR')) {
  console.error('❌ Set BOT_TOKEN env var (BOT_TOKEN=123:ABC).');
  process.exit(1);
}
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!isUserAllowed(userId)) {
    await bot.sendMessage(
      chatId,
      `Access denied. Telegram user ID ${userId ?? 'unknown'} is not allowed to interact with this bot instance.`
    );
    return;
  }

  if (msg.text === '/start') {
    await bot.sendMessage(
      chatId,
      `Hi! Send me a ZIP with images. I will caption each image using Ollama (${CURRENT_OLLAMA_MODEL}) and send back a ZIP with .txt captions.\n\n${buildHelpMessage()}`
    );
    return;
  }

  if (msg.text === '/help') {
    await bot.sendMessage(
      chatId,
      buildHelpMessage()
    );
    return;
  }

  if (msg.text === '/status') {
    await bot.sendMessage(
      chatId,
      buildStatusMessage()
    );
    return;
  }

  if (msg.text === '/prompt') {
    await bot.sendMessage(
      chatId,
      `Current caption prompt:\n${CAPTION_PROMPT}\n\nSend \`/prompt some prompt\` to override it at runtime, or \`/restore prompt\` to restore the default prompt.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (msg.text?.startsWith('/prompt ')) {
    const nextPrompt = msg.text.slice('/prompt'.length).trim();

    if (!nextPrompt) {
      await bot.sendMessage(
        chatId,
        'Prompt override cannot be empty.'
      );
      return;
    }

    CAPTION_PROMPT = nextPrompt;
    await bot.sendMessage(
      chatId,
      `Caption prompt updated to:\n${CAPTION_PROMPT}`
    );
    return;
  }

  if (msg.text === '/restore prompt') {
    CAPTION_PROMPT = process.env.CAPTION_PROMPT || DEFAULT_CAPTION_PROMPT;
    await bot.sendMessage(
      chatId,
      'Default caption prompt restored.'
    );
    return;
  }

  if (msg.text === '/ping') {
    try {
      const id = crypto.randomBytes(4).toString('hex');
      await ollama.generate({ model: CURRENT_OLLAMA_MODEL, prompt: `ping ${id}` });
      await bot.sendMessage(chatId, `Ollama OK (model: ${CURRENT_OLLAMA_MODEL})`);
    } catch (e) {
      await bot.sendMessage(chatId, 'Ollama not responding. Is it running?');
    }
    return;
  }

  if (msg.text === '/models') {
    try {
      const response = await ollama.list();
      const models = response.models || [];

      if (models.length === 0) {
        await bot.sendMessage(chatId, 'No Ollama models found on this server.');
        return;
      }

      const modelNames = models.map((model) => `- ${model.model || model.name || 'unknown'}`);
      await bot.sendMessage(
        chatId,
        ['Available Ollama models:', ...modelNames].join('\n')
      );
    } catch (e) {
      await bot.sendMessage(chatId, 'Failed to load Ollama models. Is Ollama running and reachable?');
    }
    return;
  }

  if (msg.text === '/model') {
    await bot.sendMessage(
      chatId,
      `Current model: ${CURRENT_OLLAMA_MODEL}\n\nSend \`/model some_model\` to switch models, or \`/restore model\` to restore the default model.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (msg.text?.startsWith('/model ')) {
    const nextModel = msg.text.slice('/model'.length).trim();

    if (!nextModel) {
      await bot.sendMessage(chatId, 'Model override cannot be empty.');
      return;
    }

    try {
      const response = await ollama.list();
      const models = response.models || [];
      const isAvailable = models.some((model) => {
        const modelName = model.model || model.name || '';
        return modelName === nextModel;
      });

      if (!isAvailable) {
        await bot.sendMessage(
          chatId,
          `Model \`${nextModel}\` is not available on this Ollama server. Use \`/models\` to see available models.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      CURRENT_OLLAMA_MODEL = nextModel;
      await bot.sendMessage(chatId, `Active model updated to: ${CURRENT_OLLAMA_MODEL}`);
    } catch (e) {
      await bot.sendMessage(chatId, 'Failed to validate the model against Ollama. Is Ollama running and reachable?');
    }
    return;
  }

  if (msg.text === '/restore model') {
    CURRENT_OLLAMA_MODEL = DEFAULT_OLLAMA_MODEL;
    await bot.sendMessage(chatId, `Default model restored: ${CURRENT_OLLAMA_MODEL}`);
    return;
  }

  if (!msg.document) {
    return;
  }

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
    model: CURRENT_OLLAMA_MODEL,
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

function parseAllowedUserIds(value) {
  return new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

function isUserAllowed(userId) {
  if (ALLOWED_TELEGRAM_USER_IDS.size === 0) {
    return true;
  }

  return ALLOWED_TELEGRAM_USER_IDS.has(String(userId));
}

function buildHelpMessage() {
  return [
    'Available commands:',
    '/help - show this help message',
    '/status - show current bot settings',
    '/ping - check Ollama connectivity',
    '/models - list available Ollama models',
    '/model - show the current active model',
    '/model some_model - override the model at runtime',
    '/restore model - restore the default model',
    '/prompt - show the current caption prompt',
    '/prompt some prompt - override the prompt at runtime',
    '/restore prompt - restore the default prompt',
    '',
    'Usage:',
    'Send a ZIP archive with images and I will return a ZIP with .txt captions.'
  ].join('\n');
}

function buildStatusMessage() {
  const whitelistStatus = ALLOWED_TELEGRAM_USER_IDS.size > 0
    ? `${ALLOWED_TELEGRAM_USER_IDS.size} allowed user(s)`
    : 'disabled';
  const promptPreview = CAPTION_PROMPT.length > 300
    ? `${CAPTION_PROMPT.slice(0, 297)}...`
    : CAPTION_PROMPT;

  return [
    'Bot status',
    `Model: ${CURRENT_OLLAMA_MODEL}`,
    `Default model: ${DEFAULT_OLLAMA_MODEL}`,
    `Ollama endpoint: http://${OLLAMA_HOST}:${OLLAMA_PORT}`,
    `Resize: ${RESIZE_ENABLED ? `enabled (max side ${RESIZE_MAX}px)` : 'disabled'}`,
    `Concurrency: ${CONCURRENCY}`,
    `Timeout: ${OLLAMA_TIMEOUT_MS} ms`,
    `Reasoning: ${THINK_ENABLED ? 'enabled' : 'disabled'}`,
    `Access whitelist: ${whitelistStatus}`,
    '',
    'Caption prompt:',
    promptPreview
  ].join('\n');
}
