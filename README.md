# Telegram Ollama Caption Bot

A small Node.js Telegram bot that accepts a ZIP archive with images, generates one caption per image with Ollama, and sends back a ZIP archive containing `.txt` caption files.

## What It Does

- Accepts a `.zip` file sent to the bot as a Telegram document.
- Extracts supported image files from the archive.
- Optionally resizes images before inference for faster processing.
- Sends each image to Ollama with a short factual caption prompt.
- Writes one `.txt` caption file per image, preserving the relative folder structure.
- Returns a `captions.zip` archive back to the user in Telegram.

Supported image formats:

- `.jpg`
- `.jpeg`
- `.png`
- `.webp`
- `.bmp`

## Requirements

- Node.js
- A Telegram bot token from BotFather
- Ollama running and reachable from this machine
- A pulled vision-capable model that matches `OLLAMA_MODEL`

Example:

```bash
ollama pull qwen3.5:2b
```

## Installation

Install dependencies:

```bash
npm install
```

Create a local env file from the example:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` and set at least `BOT_TOKEN`.

## Configuration

The script loads environment variables from `.env` using `dotenv`.

Available options:

| Variable | Default | Description |
| --- | --- | --- |
| `BOT_TOKEN` | none | Telegram bot token. Required. |
| `ALLOWED_TELEGRAM_USER_IDS` | empty | Comma-separated whitelist of allowed Telegram user IDs. If empty, anyone can interact with the bot. |
| `OLLAMA_MODEL` | `qwen3.5:2b` | Ollama model name used for caption generation. |
| `OLLAMA_HOST` | `127.0.0.1` | Hostname or IP address of the Ollama server. |
| `OLLAMA_PORT` | `11434` | Port of the Ollama server. |
| `CAPTION_PROMPT` | built-in prompt | Base prompt used for caption generation at startup. |
| `CAPTION_CONCURRENCY` | `1` | How many images are processed in parallel. |
| `RESIZE_ENABLED` | `1` | Enable pre-resizing before inference. Set to `0` to disable. |
| `RESIZE_MAX` | `368` | Maximum image width or height when resizing is enabled. |
| `OLLAMA_TIMEOUT_MS` | `60000` | Timeout before aborting a single Ollama request. |
| `THINK_ENABLED` | `0` | Enables Ollama reasoning mode if supported by the model. Set to `1` to enable. |

Example `.env`:

```env
BOT_TOKEN=PUT_YOUR_TELEGRAM_BOT_TOKEN_HERE
ALLOWED_TELEGRAM_USER_IDS=123456789,987654321
OLLAMA_MODEL=qwen3.5:2b
OLLAMA_HOST=127.0.0.1
OLLAMA_PORT=11434
CAPTION_PROMPT=
CAPTION_CONCURRENCY=1
RESIZE_ENABLED=1
RESIZE_MAX=368
OLLAMA_TIMEOUT_MS=60000
THINK_ENABLED=0
```

## Running

Start the bot:

```bash
node index.js
```

The bot uses long polling via `node-telegram-bot-api`.

## Telegram Usage

Available commands:

- `/start` shows a short usage message.
- `/help` shows the list of available commands.
- `/ping` checks whether Ollama responds for the configured model.
- `/status` shows a formatted summary of the active bot configuration and current prompt.
- `/prompt` shows the current caption prompt and how to change it.
- `/prompt some prompt` updates the in-memory caption prompt used for future caption generation.
- `/restore prompt` resets the runtime prompt back to `CAPTION_PROMPT` from `.env`, or the built-in default if that env variable is not set.

Access control:

- If `ALLOWED_TELEGRAM_USER_IDS` is set, only those Telegram user IDs may use the bot.
- Any non-whitelisted user gets a deny message that includes their Telegram user ID.

Main workflow:

1. Send a ZIP archive containing images to the bot.
2. Optionally add a Telegram caption to the ZIP message.
3. The bot appends that caption text to the built-in prompt.
4. The bot processes each supported image and generates a matching `.txt` file.
5. The bot sends back `captions.zip`.

## How Captions Are Generated

The bot uses a short built-in prompt focused on factual image description:

- One short English description
- No guessing
- Concise, style-neutral wording
- Avoids camera-language such as "a photo of"

The generated caption is lightly cleaned before saving:

- surrounding quotes are removed
- repeated whitespace is collapsed
- some apostrophe-like characters are normalized
- a leading `The image shows ` prefix is removed if present

## Notes

- If the uploaded ZIP contains no supported images, the bot reports that back to the user.
- The bot retries failed image processing up to 3 times per image.
- Temporary files are created in the OS temp directory and removed after processing.
- Folder structure inside the input ZIP is preserved in the output captions archive.

## Project Files

- `index.js`: bot entrypoint and processing logic
- `.env.example`: sample configuration
- `package.json`: project metadata and dependencies
