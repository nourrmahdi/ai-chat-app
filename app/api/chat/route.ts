import {
  streamText,
  convertToModelMessages,
  toUIMessageStream,
  createUIMessageStreamResponse,
  isToolUIPart,
  stepCountIs,
  APICallError,
  type UIMessage,
} from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { MODELS, getModel } from "@/lib/models";
import { buildTools, type ChatDocument } from "@/lib/tools";
import { loadContent } from "@/lib/documents";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Images, long documents and file generation can take a while
export const maxDuration = 60;

// Only the most recent messages are sent, so long chats don't exceed the context window
const MAX_MESSAGES = 20;

// Maximum model steps per answer (each tool call + the final reply is one step)
const MAX_STEPS = 6;

// Documents up to this size are put directly into the prompt; bigger ones are used through tools (RAG)
const INLINE_DOC_CHARS = 30_000;
const INLINE_TOTAL_CHARS = 60_000;

function instructions(docs: ChatDocument[]) {
  return `You are a helpful assistant in a chat app that supports images and files.
- Use Markdown formatting when it helps.

IMAGES
- You can create images with the generateImage tool. Call it whenever the user asks you to create, draw, design, generate, edit, change, restyle, regenerate or make a variation of an image. Never say you can't make images.
- To edit an existing image, make a variation, or use an image as a reference, pass its URL in referenceImageUrls. Image URLs appear as "[Image URL: ...]" notes or in earlier generateImage results.
- Write rich prompts for the image model. The app shows generated images automatically: don't repeat their URLs.

DOCUMENTS
- Uploaded documents appear as "[Document: ...]" notes. Small documents include their full text. Large documents don't fit: use searchDocuments to find relevant passages, readDocument to read parts in order, and summarizeDocument to summarize a whole document.
- Users often ask in everyday words while documents use formal terms. When you call searchDocuments, always pass several phrasings: the user's words plus the formal terms a document would use.
- If a search doesn't find what you need, search again with different, shorter keywords (synonyms, the exact terms the document might use) before concluding that the document doesn't contain it. Don't read a large document from the beginning to look for one fact: use readDocument only near a part that a search found. You have a limited number of steps, so always finish with an answer.
- Base your answers on the documents and mention which document (and page or part) information comes from. If the documents don't contain the answer, say so.
- To compare documents, read or search each of them, then compare.
- For any calculation on Excel or CSV data (totals, averages, counts, min/max, per group), call analyzeTable and use its exact results. Never add up or average numbers yourself, and copy its numbers exactly into answers and files.
- Use extractData to pull structured data (invoice fields, tables, lists) as validated JSON, and set saveAs when the user wants a spreadsheet or JSON file.
- Use createFile whenever the user wants a file (Word, PDF, Excel, CSV, Markdown, code), including an edited version of an uploaded file: read it first, then write the complete new content. The app shows a download button automatically: don't repeat file URLs.
${docs.length ? `\nDocuments in this chat: ${docs.map((d) => `"${d.name}"`).join(", ")}` : ""}`;
}

// All documents uploaded anywhere in the chat (even older messages), so tools can always use them
function collectDocuments(messages: UIMessage[]): ChatDocument[] {
  const docs: ChatDocument[] = [];
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type === "file" && !part.mediaType.startsWith("image") && !docs.some((d) => d.url === part.url)) {
        docs.push({ url: part.url, name: part.filename ?? "document" });
      }
    }
  }
  return docs;
}

// Only images from our own Blob storage are downloaded by the server
const BLOB_HOST = /\.public\.blob\.vercel-storage\.com$/;

// Downloads an image and turns it into base64. Some providers (e.g. Google) can't fetch image URLs
// themselves, so sending the image data directly works with every vision model.
async function toDataUrl(url: string): Promise<string> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !BLOB_HOST.test(parsed.hostname)) return url;
    const res = await fetch(url);
    if (!res.ok) return url;
    const type = res.headers.get("content-type") ?? "image/png";
    const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    return `data:${type};base64,${base64}`;
  } catch {
    return url;
  }
}

// Adapt the history to what the chosen model can handle
async function prepareMessages(messages: UIMessage[], canSeeImages: boolean): Promise<UIMessage[]> {
  let inlineBudget = INLINE_TOTAL_CHARS;

  const prepared: UIMessage[] = [];
  for (const message of messages) {
    const parts: UIMessage["parts"] = [];
    for (const part of message.parts) {
      // Drop unfinished tool calls (for example if the user pressed Stop)
      if (isToolUIPart(part) && part.state !== "output-available" && part.state !== "output-error") continue;

      if (part.type !== "file") {
        parts.push(part);
        continue;
      }

      // ----- Documents: send their text (small ones) or a note (large ones) -----
      if (!part.mediaType.startsWith("image")) {
        const content = await loadContent(part.url).catch(() => null);
        const name = part.filename ?? "document";
        if (!content) {
          parts.push({ type: "text", text: `[Document: "${name}" could not be loaded.]` });
        } else if (content.chars <= INLINE_DOC_CHARS && content.chars <= inlineBudget) {
          inlineBudget -= content.chars;
          parts.push({
            type: "text",
            text: `[Document: "${name}" (${content.chars.toLocaleString()} characters${content.pages ? `, ${content.pages} pages` : ""}), full text:]\n${content.chunks.join("\n")}\n[End of "${name}"]`,
          });
        } else {
          parts.push({
            type: "text",
            text: `[Document: "${name}" — large document (${content.chars.toLocaleString()} characters${content.pages ? `, ${content.pages} pages` : ""}, ${content.chunks.length} parts${content.truncated ? ", only the beginning was indexed" : ""}). It does not fit in the context: use searchDocuments, readDocument or summarizeDocument.]`,
          });
        }
        continue;
      }

      // ----- Images -----
      if (canSeeImages) {
        // Send the image itself (base64) + its URL as text, so the model can reference it in tool calls
        parts.push({ ...part, url: await toDataUrl(part.url) }, { type: "text", text: `[Image URL: ${part.url}]` });
      } else {
        // Text-only model: replace the image with a note so the context still makes sense
        parts.push({
          type: "text",
          text: `[The user attached an image${part.filename ? ` "${part.filename}"` : ""}, but the current model cannot view images. If asked about it, suggest switching to a vision model. Image URL: ${part.url}]`,
        });
      }
    }
    prepared.push({ ...message, parts });
  }
  return prepared;
}

// Turn technical errors into clear messages for the user
function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";

  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return "Rate limit reached for this model. Wait a moment and retry, or switch models.";
    if (error.statusCode === 402) return "The API key has run out of credits.";
    if (error.statusCode === 401) return "The server's API key is invalid.";
    if (error.statusCode === 413) return "The request is too large. Try fewer or smaller files.";
    if (error.statusCode && error.statusCode >= 500) return "The model provider is having problems. Retry or switch models.";
  }

  if (/no endpoints|not found/i.test(message)) return "This model is currently unavailable. Please pick another one.";
  if (/context|too long|maximum.*tokens/i.test(message)) return "The conversation is too long for this model. Start a new chat or pick a model with a bigger context.";
  if (/image/i.test(message) && /support/i.test(message)) return "This model can't read images. Please switch to a vision model.";

  return message || "Something went wrong. Please try again.";
}

export async function POST(req: Request) {
  const { messages, model }: { messages: UIMessage[]; model: string } = await req.json();

  // Only allow models from our list (protects the API credits)
  if (!MODELS.some((m) => m.id === model)) {
    return new Response("Unknown model.", { status: 400 });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return new Response("The server is missing its API key.", { status: 500 });
  }

  const docs = collectDocuments(messages);
  const tools = buildTools(docs);
  const canSeeImages = getModel(model)?.vision ?? false;
  const history = await prepareMessages(messages.slice(-MAX_MESSAGES), canSeeImages);

  const result = streamText({
    model: openrouter(model),
    instructions: instructions(docs),
    messages: await convertToModelMessages(history),
    tools,
    stopWhen: stepCountIs(MAX_STEPS), // allow multi-step work: search → read → create a file → reply
    // On the last step, tools are turned off so the model always finishes with a written answer
    prepareStep: ({ stepNumber }) => (stepNumber >= MAX_STEPS - 1 ? { toolChoice: "none" } : undefined),
    temperature: 0.7,
    maxOutputTokens: 4000, // file contents are written by the model, so allow longer answers
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      tools,
      // Attach the model name to each reply so the UI can label it
      messageMetadata: ({ part }) => (part.type === "start" ? { model } : undefined),
      onError: friendlyError,
    }),
  });
}
