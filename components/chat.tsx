"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { ArrowUp, Square, RotateCcw, AlertCircle } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { MODELS, modelLabel } from "@/lib/models";

export type ChatMessage = UIMessage<{ model?: string }>;

type Props = {
  id: string;
  initialMessages: ChatMessage[];
  model: string;
  onModelChange: (model: string) => void;
  onSave: (messages: ChatMessage[]) => void;
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
};

const textOf = (m: ChatMessage) =>
  m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
const signature = (msgs: ChatMessage[]) =>
  `${msgs.length}:${msgs.at(-1)?.id ?? ""}`;

export function Chat({ id, initialMessages, model, onModelChange, onSave, headerLeft, headerRight }: Props) {
  const [input, setInput] = useState("");
  const { messages, sendMessage, regenerate, stop, status, error } =
    useChat<ChatMessage>({ id, messages: initialMessages });

  const busy = status === "submitted" || status === "streaming";

  const bottomRef = useRef<HTMLDivElement>(null);
  const savedSig = useRef(signature(initialMessages));

  // Auto-scroll to the newest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, status]);

  // Save the conversation when a reply finishes (or fails)
  useEffect(() => {
    if (status !== "ready" && status !== "error") return;
    const sig = signature(messages);
    if (sig === savedSig.current) return;
    savedSig.current = sig;
    onSave(messages);
  }, [status, messages, onSave]);

  function send() {
    const text = input.trim();
    if (!text || busy) return;
    sendMessage({ text }, { body: { model } });
    setInput("");
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        {headerLeft}
        <select
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={busy}

          aria-label="Model"
          className="min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.provider})
            </option>
          ))}
        </select>
        <div className="ml-auto">{headerRight}</div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          {messages.length === 0 && (
            <div className="mt-24 text-center text-muted-foreground">
              <p className="text-lg font-medium text-foreground">Start a conversation</p>
              <p className="mt-1 text-sm">
                Switch models at any time. The new model sees the whole conversation.
              </p>
            </div>
          )}

          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-4 py-2 text-primary-foreground">
                  {textOf(m)}
                </div>
              </div>
            ) : (
              <div key={m.id} className="flex flex-col gap-1">

                <span className="w-fit rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {modelLabel(m.metadata?.model)}
                </span>
                <Markdown>{textOf(m)}</Markdown>
              </div>
            )
          )}

          {status === "submitted" && (
            <p className="text-sm text-muted-foreground">Thinking…</p>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <p className="flex-1">{error.message}</p>
              <button
                onClick={() => regenerate({ body: { model } })}
                className="flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 hover:bg-destructive/10"
              >
                <RotateCcw className="size-3.5" /> Retry
              </button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();

        }}
        className="border-t border-border p-3"
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder="Type a message… (Shift+Enter for a new line)"
            className="max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-border bg-background px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          {busy ? (
            <button type="button" onClick={() => stop()} aria-label="Stop" className="rounded-xl border border-border p-3 hover:bg-muted">
              <Square className="size-4" />
            </button>
          ) : (
            <button type="submit" aria-label="Send" className="rounded-xl bg-primary p-3 text-primary-foreground disabled:opacity-50" disabled={!input.trim()}>
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}