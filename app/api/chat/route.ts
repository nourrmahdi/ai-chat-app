import { streamText, convertToModelMessages, APICallError, type UIMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { MODELS } from "@/lib/models";

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

export const maxDuration = 30;

// Only the most recent messages are sent, so long chats don't exceed the context window
const MAX_MESSAGES = 20;

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return "Rate limit reached for this model. Wait a moment and retry, or switch models.";
    if (error.statusCode === 402) return "The API key has run out of credits.";
    if (error.statusCode === 401) return "The server's API key is invalid.";
    if (error.statusCode && error.statusCode >= 500) return "The model provider is having problems. Retry or switch models.";
  }
  if (/no endpoints|not found/i.test(message)) return "This model is currently unavailable. Please pick another one.";
  return message || "Something went wrong. Please try again.";
}

export async function POST(req: Request) {
  const { messages, model } = (await req.json()) as { messages: UIMessage[]; model: string };

  // Only allow models from our list (protects the API credits)
  if (!MODELS.some((m) => m.id === model)) {
    return new Response("Unknown model.", { status: 400 });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return new Response("The server is missing its API key.", { status: 500 });

  }

  const result = streamText({
    model: openrouter(model),
    system: "You are a helpful assistant. Use Markdown formatting when it helps.",
    messages: await convertToModelMessages(messages.slice(-MAX_MESSAGES)),
    temperature: 0.7,
  });

  return result.toUIMessageStreamResponse({
    // Attach the model name to each reply so the UI can label it
    messageMetadata: ({ part }) => (part.type === "start" ? { model } : undefined),
    onError: friendlyError,
  });
}