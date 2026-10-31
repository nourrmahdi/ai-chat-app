# AI Chat – Multi-Model & Multimodal Chat App

A chat application connected to many LLM providers through **OpenRouter**. You can switch models **in the middle of a conversation** without losing context, upload images for the AI to analyze, and ask it to **create and edit images**. The chat model decides by itself when to generate an image, using **tool calling**.

**Live demo:** https://ai-chat-app-six-bice.vercel.app

---

## Features

### Chat (Project 2)
- **Streaming responses**: replies appear token by token
- **5 chat models from 5 providers**, selectable from a dropdown
- **Mid-conversation model switching**: the full history is sent to the new model, so context is kept
- **Model label on every reply**, showing which model produced it
- **Markdown and code-block rendering**
- **Conversation management**: create, rename, delete, and reopen chats (saved in browser `localStorage`)
- **Error handling**: clear messages for rate limits, unavailable models, missing credits, and provider errors, with **Retry** and **Stop** buttons
- **Context trimming**: only the last 20 messages are sent
- **Generation parameters**: temperature 0.7, max 1,000 output tokens per reply
- **Responsive UI** (slide-out sidebar on mobile) with **light and dark mode**

### Images (Project 3)
- **Image upload** by **drag-and-drop**, **paste (Ctrl + V)**, or **file picker**, with **previews** and upload spinners (up to 4 images per message)
- **Image understanding** with vision models: description, analysis, **text extraction (OCR)**, questions about an image, and **comparing several images**
- **Image generation from text** ("Draw a cat astronaut on the moon")
- **Image generation from a reference image** ("Turn this photo into a winter scene")
- **Edit**, **Regenerate**, and **Variation** buttons on every generated image
- **Download** button for generated images
- **Tool calling**: the chat model decides on its own when to call the `generateImage` tool, so there's no separate "image mode"
- **Capability detection**: the model list shows which models are **vision** or **text only**. When a text-only model is selected, images are replaced by a text note, so the conversation still works, and the UI shows a warning
- **Loading states** for slower requests ("Generating image…", upload spinners)
- **Large images are shrunk in the browser** (max 1600 px) before upload

---

## Models used

### Chat models (in the dropdown)
| Model | Provider | OpenRouter ID | Vision |
|---|---|---|---|
| GPT-4o mini | OpenAI | `openai/gpt-4o-mini` | ✅ |
| Claude Haiku 5.5 | Anthropic | `anthropic/claude-haiku-5.5` | ✅ |
| Gemini 2.5 Flash | Google | `google/gemini-2.5-flash` | ✅ |
| Llama 3.3 70B Instruct | Meta | `meta-llama/llama-3.3-70b-instruct` | ❌ text only |
| Mistral Small 3.2 24B | Mistral | `mistralai/mistral-small-3.2-24b-instruct` | ✅ |

### Image-generation model (used by the tool)
| Model | Provider | OpenRouter ID |
|---|---|---|
| Gemini 2.5 Flash Image | Google | `google/gemini-2.5-flash-image` |

---

## How it works

```
Browser (app/page.tsx, components/chat.tsx)
  │  1. Images are shrunk and uploaded → /api/upload → Vercel Blob → public URL
  │  2. The message (text + image URLs) and the full history are sent with the chosen model
  ▼
/api/chat (server)                              ← API keys live only here
  │  • Checks the model is allowed, trims the history
  │  • Vision models: images are downloaded and sent as base64
  │  • Text-only models: images are replaced by a text note
  │  • Gives the model the generateImage tool
  ▼
Chat model (via OpenRouter)
  │  Decides to answer with text, or to call generateImage(prompt, referenceImageUrls)
  ▼
generateImage tool (server)
  │  Calls Gemini 2.5 Flash Image with the prompt (+ reference images as base64)
  │  Saves the result to Vercel Blob and returns its URL
  ▼
Chat model reads the tool result and writes a short reply
  ▼
Browser shows the image with Download / Edit / Regenerate / Variation buttons
```

### Tool calling
`generateImage` is defined with a **Zod schema** (`prompt`, optional `referenceImageUrls`, optional `aspectRatio`). The chat model receives the tool's description with every request and **decides by itself** when to use it. The result (image URL and prompt) is returned into the conversation, so later messages and other models keep that context. The Edit, Regenerate, and Variation buttons send normal chat messages, and the model calls the tool again with the right reference image.

### Images: URLs vs base64
Uploaded and generated images are stored in **Vercel Blob** and saved in the chat as **URLs**, so `localStorage` stays small. When a request is sent to a model, the server **downloads each image and sends it as base64**, because some providers (for example Google) can't fetch image URLs themselves.

---

## Context is kept when switching models

Every request sends the **entire conversation** to the selected model. In the example below, only **GPT-4o mini** was told the name, and every other model knew it after the switch:

![Context kept when switching models](docs/context-switch.png)

The same applies to images: an image analyzed by one vision model can be discussed by another, and a text-only model (Llama 3.3) still knows an image was shared and what earlier replies said about it.

---

## Tech stack
- **Next.js** (App Router) + **TypeScript**
- **Tailwind CSS** + **shadcn/ui**
- **Vercel AI SDK** (`ai`, `@ai-sdk/react`) with the **OpenRouter provider**, plus **Zod** for the tool schema
- **Vercel Blob** for uploaded and generated images
- **Vercel** (Hobby plan) for hosting
- **localStorage** for conversations

---

## Setup (run locally)

1. **Clone the repo**
   ```bash
   git clone https://github.com/nourrmahdi/ai-chat-app.git
   cd ai-chat-app
   ```
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Create a Vercel Blob store** (Vercel → Storage → Create → Blob, **public** access) and copy its read-write token.
4. **Add your keys.** Copy `.env.example` to `.env.local` and fill in:
   ```
   OPENROUTER_API_KEY=your-openrouter-key
   BLOB_READ_WRITE_TOKEN=your-blob-token
   ```
   `.env.local` is git-ignored and never committed.
5. **Start the dev server**
   ```bash
   npm run dev
   ```
   Open http://localhost:3000.

## Deploying to Vercel
1. Import the GitHub repo at vercel.com/new.
2. Add `OPENROUTER_API_KEY` under **Environment Variables**.
3. Create a **Blob** store under **Storage** and connect it to the project. This adds `BLOB_READ_WRITE_TOKEN`.
4. Deploy. Every push to `main` redeploys automatically.

---

## Security
- API keys are **only** used in server routes (`app/api/chat/route.ts`, `app/api/upload/route.ts`, `lib/generate-image.ts`).
- They're stored in `.env.local` locally (git-ignored) and as **Vercel Environment Variables** in production. They never appear in the repository or in client-side code.
- The server only accepts **chat models from an allow-list**.
- Uploads are checked server-side: images only (PNG, JPEG, WebP, GIF), max 4 MB.
- The server only downloads reference images from **our own Blob storage**.

---

## Known limitations
- **Chats are stored in the browser** (`localStorage`): they don't sync across devices and are lost if browser data is cleared. Images are stored in Blob, so they stay online.
- **Images are public**: anyone with an image's link can open it (links are long and random). Images aren't deleted from Blob when a chat is deleted. Don't upload sensitive images.
- **Generated images aren't "seen" by later models**: models know the prompt and link of a generated image, but only see its pixels if it's used as a reference.
- **Edits regenerate the whole image**: the image model may change more than asked.
- **Image generation is slower** (often 10–30 s) and can occasionally fail. The app retries once and shows the reason if it still fails.
- **Text-only models** (Llama 3.3) can't see images. They only get a note that an image was shared.
- **Only one image-generation model** (Gemini 2.5 Flash Image).
- **Simple history trimming** (last 20 messages); token-based trimming would be more precise.
- **Model availability depends on OpenRouter**: models can be retired (Claude 3.5 Haiku and Gemini 2.0 Flash were retired during development and replaced).
- **Vercel Hobby limits**: 4.5 MB per upload request (images are shrunk to fit) and up to 60 s per request.
- **No user accounts or authentication.**