"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { FileUIPart, UIDataTypes, UIMessage } from "ai";
import {
  AlertCircle,
  ArrowUp,
  Download,
  EyeOff,
  ImagePlus,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Shuffle,
  Square,
  X,
} from "lucide-react";
import { Markdown } from "@/components/markdown";
import { MODELS, modelLabel, formatContext, getModel } from "@/lib/models";
import { uploadImage } from "@/lib/image-utils";
import type { GenerateImageInput, GenerateImageOutput } from "@/lib/generate-image";

// Message type: model name in metadata + our generateImage tool
type ChatTools = {
  generateImage: { input: GenerateImageInput; output: GenerateImageOutput };
};
export type ChatMessage = UIMessage<{ model?: string }, UIDataTypes, ChatTools>;

type Attachment = {
  id: string;
  previewUrl: string; // local preview shown instantly
  status: "uploading" | "done" | "error";
  url?: string; // public Blob URL once uploaded
  mediaType: string;
  filename: string;
  error?: string;
};

type Props = {
  id: string;
  initialMessages: ChatMessage[];
  model: string;
  onModelChange: (model: string) => void;
  onSave: (messages: ChatMessage[]) => void;
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
};

const MAX_ATTACHMENTS = 4;

const textOf = (m: ChatMessage) =>
  m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
const imagesOf = (m: ChatMessage) =>
  m.parts.filter((p): p is FileUIPart => p.type === "file" && p.mediaType.startsWith("image"));
const signature = (msgs: ChatMessage[]) => `${msgs.length}:${msgs.at(-1)?.id ?? ""}`;

// "[Image URL: ...]" notes (from Edit / Variation buttons) are shown as thumbnails, not raw links
const URL_NOTE = /\s*\[Image URL: ([^\]]+)\]/g;
const referencedUrls = (text: string) => [...text.matchAll(URL_NOTE)].map((match) => match[1]);
const withoutUrlNotes = (text: string) => text.replace(URL_NOTE, "").trim();

export function Chat({ id, initialMessages, model, onModelChange, onSave, headerLeft, headerRight }: Props) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const { messages, sendMessage, regenerate, stop, status, error } =
    useChat<ChatMessage>({ id, messages: initialMessages });

  const busy = status === "submitted" || status === "streaming";
  const uploading = attachments.some((a) => a.status === "uploading");
  const info = getModel(model);
  const canSeeImages = info?.vision ?? false;
  const chatHasImages = messages.some((m) => imagesOf(m).length > 0) || attachments.length > 0;

  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  // Add images from the file picker, drag-and-drop, or paste
  function addFiles(fileList: FileList | File[]) {
    setUploadError(null);
    const images = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) {
      setUploadError("Only image files can be attached.");
      return;
    }
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setUploadError(`You can attach up to ${MAX_ATTACHMENTS} images per message.`);
      return;
    }

    for (const file of images.slice(0, room)) {
      const attachment: Attachment = {
        id: crypto.randomUUID(),
        previewUrl: URL.createObjectURL(file),
        status: "uploading",
        mediaType: file.type,
        filename: file.name,
      };
      setAttachments((prev) => [...prev, attachment]);

      uploadImage(file)
        .then((uploaded) =>
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === attachment.id
                ? { ...a, status: "done", url: uploaded.url, mediaType: uploaded.mediaType }
                : a
            )
          )
        )
        .catch((err: Error) => {
          setUploadError(`Upload failed: ${err.message}`);
          setAttachments((prev) =>
            prev.map((a) => (a.id === attachment.id ? { ...a, status: "error", error: err.message } : a))
          );
        });
    }
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === attachmentId);
      if (found) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((a) => a.id !== attachmentId);
    });
  }

  function send() {
    const text = input.trim();
    const ready = attachments.filter((a) => a.status === "done" && a.url);
    if ((!text && ready.length === 0) || busy || uploading) return;

    const files: FileUIPart[] = ready.map((a) => ({
      type: "file",
      mediaType: a.mediaType,
      url: a.url!,
      filename: a.filename,
    }));

    if (text) sendMessage({ text, files }, { body: { model } });
    else sendMessage({ files }, { body: { model } });

    attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    setAttachments([]);
    setInput("");
  }

  // Quick actions on generated images (they go through the chat, so the model calls the tool)
  function sendInstruction(text: string) {
    if (busy) return;
    sendMessage({ text }, { body: { model } });
  }

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-background/80 text-sm font-medium">
          Drop images to attach them
        </div>
      )}

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
              {m.name} ({m.provider}){m.vision ? " · vision" : " · text only"}
            </option>
          ))}
        </select>
        {info && (
          <span className="hidden truncate text-xs text-muted-foreground md:inline">
            {formatContext(info.contextWindow)} context · {info.bestFor}
          </span>
        )}
        <div className="ml-auto">{headerRight}</div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          {messages.length === 0 && (
            <div className="mt-24 text-center text-muted-foreground">
              <p className="text-lg font-medium text-foreground">Start a conversation</p>
              <p className="mt-1 text-sm">
                Ask anything, attach images to analyze, or ask for an image to be created.
              </p>
            </div>
          )}

          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="flex flex-col items-end gap-2">
                {(imagesOf(m).length > 0 || referencedUrls(textOf(m)).length > 0) && (
                  <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
                    {[...imagesOf(m).map((img) => img.url), ...referencedUrls(textOf(m))].map((url) => (
                      <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={url}
                          alt="Attached image"
                          className="h-32 w-32 rounded-xl border border-border object-cover"
                        />
                      </a>
                    ))}
                  </div>
                )}
                {withoutUrlNotes(textOf(m)) && (
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-4 py-2 text-primary-foreground">
                    {withoutUrlNotes(textOf(m))}
                  </div>
                )}
              </div>
            ) : (
              <div key={m.id} className="flex flex-col gap-2">
                <span className="w-fit rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {modelLabel(m.metadata?.model)}
                </span>
                {m.parts.map((part, i) => {
                  if (part.type === "text") {
                    return part.text ? <Markdown key={i}>{part.text}</Markdown> : null;
                  }
                  if (part.type === "tool-generateImage") {
                    if (part.state === "output-available") {
                      const out = part.output;
                      return (
                        <GeneratedImage
                          key={i}
                          output={out}
                          disabled={busy}
                          onRegenerate={() =>
                            sendInstruction(`Regenerate this image using the same prompt: "${out.prompt}"`)
                          }
                          onVariation={() =>
                            sendInstruction(
                              `Create a variation of this image: same subject, different details and composition. [Image URL: ${out.url}]`
                            )
                          }
                          onEdit={() => {
                            const change = window.prompt("What would you like to change in this image?");
                            if (change?.trim()) sendInstruction(`Edit this image: ${change.trim()} [Image URL: ${out.url}]`);
                          }}
                        />
                      );
                    }
                    if (part.state === "output-error") {
                      return (
                        <div key={i} className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                          <AlertCircle className="mt-0.5 size-4 shrink-0" />
                          <p>Image generation failed: {part.errorText}</p>
                        </div>
                      );
                    }
                    return (
                      <div key={i} className="flex h-64 w-64 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground">
                        <Loader2 className="size-5 animate-spin" />
                        Generating image…
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            )
          )}

          {status === "submitted" && <p className="text-sm text-muted-foreground">Thinking…</p>}

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
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {!canSeeImages && chatHasImages && (
            <p className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              <EyeOff className="size-3.5 shrink-0" />
              {info?.name} is text-only: it will know an image was shared but can&apos;t see it. Switch to a vision model to ask about images.
            </p>
          )}
          {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((a) => (
                <div key={a.id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.previewUrl}
                    alt={a.filename}
                    className={`h-16 w-16 rounded-lg border object-cover ${a.status === "error" ? "border-destructive opacity-50" : "border-border"}`}
                  />
                  {a.status === "uploading" && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                      <Loader2 className="size-4 animate-spin" />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label="Remove image"
                    title={a.error ?? "Remove"}
                    className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach images"
              className="rounded-xl border border-border p-3 hover:bg-muted"
            >
              <ImagePlus className="size-4" />
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
                if (files.length) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="Message, paste or drop images… (Shift+Enter for a new line)"
              className="max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-border bg-background px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            {busy ? (
              <button type="button" onClick={() => stop()} aria-label="Stop" className="rounded-xl border border-border p-3 hover:bg-muted">
                <Square className="size-4" />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send"
                className="rounded-xl bg-primary p-3 text-primary-foreground disabled:opacity-50"
                disabled={uploading || (!input.trim() && !attachments.some((a) => a.status === "done"))}
              >
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

// A generated image with its action buttons
function GeneratedImage({
  output,
  disabled,
  onRegenerate,
  onVariation,
  onEdit,
}: {
  output: GenerateImageOutput;
  disabled: boolean;
  onRegenerate: () => void;
  onVariation: () => void;
  onEdit: () => void;
}) {
  const button =
    "flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50";

  return (
    <figure className="flex w-fit max-w-full flex-col gap-2">
      <a href={output.url} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={output.url}
          alt={output.prompt}
          className="max-h-96 max-w-full rounded-xl border border-border object-contain"
        />
      </a>
      <figcaption className="text-xs text-muted-foreground">
        Generated by {output.model}
        {output.usedReferences > 0 ? ` from ${output.usedReferences} reference image(s)` : ""}
      </figcaption>
      <div className="flex flex-wrap gap-2">
        <a href={output.downloadUrl} className={button}>
          <Download className="size-3.5" /> Download
        </a>
        <button type="button" onClick={onEdit} disabled={disabled} className={button}>
          <Pencil className="size-3.5" /> Edit
        </button>
        <button type="button" onClick={onRegenerate} disabled={disabled} className={button}>
          <RefreshCw className="size-3.5" /> Regenerate
        </button>
        <button type="button" onClick={onVariation} disabled={disabled} className={button}>
          <Shuffle className="size-3.5" /> Variation
        </button>
      </div>
    </figure>
  );
}