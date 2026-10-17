import { streamText, convertToModelMessages, type UIMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

// Connect to OpenRouter using the secret key from .env.local
const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Allow a reply to stream for up to 30 seconds
export const maxDuration = 30;

// This runs when the browser sends a message (POST request to /api/chat)
export async function POST(req: Request) {
  // 1. Read what the browser sent: the whole conversation + chosen model
  const { messages, model }: { messages: UIMessage[]; model: string } =
    await req.json();

  // 2. Send the FULL history to the chosen model and start streaming
  const result = streamText({
    model: openrouter(model),
    messages: await convertToModelMessages(messages),
  });

  // 3. Stream the reply back to the browser, word by word
  return result.toUIMessageStreamResponse();
}