"use client";

import { useState } from "react";
import { useChat } from "@ai-sdk/react";

// The models the user can choose from (OpenRouter IDs)
const MODELS = [
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini (OpenAI)" },
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5 (Anthropic)" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash (Google)" },
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B (Meta)" },
  { id: "mistralai/mistral-small-3.2-24b-instruct", name: "Mistral Small (Mistral)" },
];

export default function Home() {
  const [model, setModel] = useState(MODELS[0].id);
  const [input, setInput] = useState("");

  // useChat keeps the message list and talks to /api/chat for us
  const { messages, sendMessage, status, error } = useChat();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    // Send the text + the currently selected model to the server
    sendMessage({ text: input }, { body: { model } });
    setInput("");
  }

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col p-4">
      {/* Model selector */}
      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        className="mb-4 rounded border p-2 bg-background"
      >
        {MODELS.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>

      {/* Messages */}
      <div className="flex-1 space-y-4 overflow-y-auto">
        {messages.map((message) => (
          <div key={message.id} className={message.role === "user" ? "text-right" : ""}>
            <div className="text-xs text-gray-500">{message.role}</div>
            {message.parts.map((part, i) =>
              part.type === "text" ? (
                <div key={i} className="whitespace-pre-wrap">{part.text}</div>
              ) : null
            )}
          </div>
        ))}
        {error && <div className="text-red-500">Error: {error.message}</div>}
      </div>

      {/* Input box */}
      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          className="flex-1 rounded border p-2"
        />
        <button
          type="submit"
          disabled={status === "streaming" || status === "submitted"}
          className="rounded border px-4"
        >
          Send
        </button>
      </form>
    </main>
  );
}