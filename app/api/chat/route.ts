import {
  streamText,
  convertToModelMessages,
  toUIMessageStream,
  createUIMessageStreamResponse,
  isToolUIPart,
  stepCountIs,
  tool,
  APICallError,
  type UIMessage,
} from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { MODELS, getModel } from "@/lib/models";
import { generateAndStoreImage } from "@/lib/generate-image";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Image generation can take 10–30 seconds, so allow longer requests
export const maxDuration = 60;

// Only the most recent messages are sent, so long chats don't exceed the context window
const MAX_MESSAGES = 20;

const INSTRUCTIONS = `You are a helpful assistant in a chat app that supports images.
- Use Markdown formatting when it helps.
- You can create images with the generateImage tool. Call it whenever the user asks you to create, draw, design, generate, edit, change, restyle, regenerate or make a variation of an image. Never say you can't make images.
- To edit an existing image, make a variation, or use an image as a reference, pass its URL in referenceImageUrls. Image URLs appear in the conversation as "[Image URL: ...]" notes or in earlier generateImage results.
- Write rich prompts for the image model: subject, style, composition, colors, lighting. For edits, describe the full desired result, not just the change.
- The app shows generated images automatically. Don't repeat their URLs or embed them as Markdown. After generating, add one short sentence about the result.`;


// The tool the chat model can decide to call
const tools = {
  generateImage: tool({
    description:
      "Generate a new image from a text description, or edit / create a variation of existing images by passing them as references.",
    inputSchema: z.object({
      prompt: z
        .string()
        .describe("Detailed description of the image to create, or of the final result after an edit."),
      referenceImageUrls: z
        .array(z.string())
        .max(3)
        .optional()
        .describe("URLs of existing images to edit, vary, or use as a style/content reference."),
      aspectRatio: z
        .enum(["1:1", "16:9", "9:16", "4:3", "3:4"])
        .optional()
        .describe("Image shape. Leave empty for square."),
    }),
    execute: async (input) => generateAndStoreImage(input),
  }),
};

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
  return Promise.all(
    messages.map(async (message) => ({
      ...message,
      parts: (
        await Promise.all(
          message.parts.map(async (part): Promise<UIMessage["parts"]> => {
            // Drop unfinished tool calls (for example if the user pressed Stop)
            if (isToolUIPart(part) && part.state !== "output-available" && part.state !== "output-error") {
              return [];
            }

            if (part.type !== "file" || !part.mediaType.startsWith("image")) return [part];

            if (canSeeImages) {
              // Send the image itself (base64) + its URL as text, so the model can reference it in tool calls
              return [
                { ...part, url: await toDataUrl(part.url) },
                { type: "text", text: `[Image URL: ${part.url}]` },
              ];

            }

            // Text-only model: replace the image with a note so the context still makes sense
            return [
              {
                type: "text",
                text: `[The user attached an image${part.filename ? ` "${part.filename}"` : ""}, but the current model cannot view images. If asked about it, suggest switching to a vision model. Image URL: ${part.url}]`,
              },
            ];
          })
        )
      ).flat(),
    }))
  );
}

// Turn technical errors into clear messages for the user
function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";

  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return "Rate limit reached for this model. Wait a moment and retry, or switch models.";
    if (error.statusCode === 402) return "The API key has run out of credits.";
    if (error.statusCode === 401) return "The server's API key is invalid.";
    if (error.statusCode === 413) return "The request is too large. Try fewer or smaller images.";
    if (error.statusCode && error.statusCode >= 500) return "The model provider is having problems. Retry or switch models.";
  }

  if (/no endpoints|not found/i.test(message)) return "This model is currently unavailable. Please pick another one.";
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

  const canSeeImages = getModel(model)?.vision ?? false;
  const history = await prepareMessages(messages.slice(-MAX_MESSAGES), canSeeImages);

  const result = streamText({
    model: openrouter(model),
    instructions: INSTRUCTIONS,
    messages: await convertToModelMessages(history),
    tools,
    stopWhen: stepCountIs(3), // allow: call the tool → read the result → reply
    temperature: 0.7,
    maxOutputTokens: 1000,
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