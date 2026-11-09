"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { FileUIPart, InferUITools, UIDataTypes, UIMessage } from "ai";
import {
  AlertCircle,
  ArrowUp,
  BookOpen,
  Calculator,
  Download,
  EyeOff,
  FileSpreadsheet,
  FileText,
  ListChecks,
  Loader2,
  Paperclip,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Shuffle,
  Square,
  X,
} from "lucide-react";
import { Markdown } from "@/components/markdown";
import { MODELS, modelLabel, formatContext, getModel } from "@/lib/models";
import { uploadDocument, uploadImage } from "@/lib/image-utils";
import { ACCEPTED_FILES, fileKind, formatBytes } from "@/lib/files";
import type { ChatTools } from "@/lib/tools";
import type { GenerateImageOutput } from "@/lib/generate-image";
import type { CreatedFile } from "@/lib/generate-file";

// Message type: model name in metadata + all our tools (images, documents, files)
export type ChatMessage = UIMessage<{ model?: string }, UIDataTypes, InferUITools<ChatTools>>;

type Attachment = {
  id: string;
  kind: "image" | "document";
  previewUrl?: string; // local preview for images
  status: "uploading" | "done" | "error";
  url?: string; // public Blob URL once uploaded
  mediaType: string;
  filename: string;
  info?: string; // e.g. "12 pages · indexed"
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
const docsOf = (m: ChatMessage) =>
  m.parts.filter((p): p is FileUIPart => p.type === "file" && !p.mediaType.startsWith("image"));
const signature = (msgs: ChatMessage[]) => `${msgs.length}:${msgs.at(-1)?.id ?? ""}`;

// "[Image URL: ...]" notes (from Edit / Variation buttons) are shown as thumbnails, not raw links
const URL_NOTE = /\s*\[Image URL: ([^\]]+)\]/g;
const referencedUrls = (text: string) => [...text.matchAll(URL_NOTE)].map((match) => match[1]);
const withoutUrlNotes = (text: string) => text.replace(URL_NOTE, "").trim();

// Passages read from documents are long and only needed once: shorten them before saving to the browser
const shorten = (text: string) => (text.length > 400 ? text.slice(0, 400) + " …[shortened]" : text);
function compactForStorage(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) => {
      if (p.type === "tool-readDocument" && p.state === "output-available") {
        return { ...p, output: { ...p.output, text: shorten(p.output.text) } };
      }
      if (p.type === "tool-searchDocuments" && p.state === "output-available") {
        return { ...p, output: { ...p.output, results: p.output.results.map((r) => ({ ...r, text: shorten(r.text) })) } };
      }
      return p;
    }),
  })) as ChatMessage[];
}

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
  const chatHasImages =
    messages.some((m) => imagesOf(m).length > 0) || attachments.some((a) => a.kind === "image");

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
    onSave(compactForStorage(messages));
  }, [status, messages, onSave]);

  function updateAttachment(attachmentId: string, changes: Partial<Attachment>) {
    setAttachments((prev) => prev.map((a) => (a.id === attachmentId ? { ...a, ...changes } : a)));
  }

  // Add images or documents from the file picker, drag-and-drop, or paste
  function addFiles(fileList: FileList | File[]) {
    setUploadError(null);
    const files = Array.from(fileList);
    const supported = files.filter((f) => fileKind(f.name, f.type));
    if (supported.length < files.length) {
      setUploadError("Some files were skipped: supported types are images, PDF, Word, Excel, CSV, code and text files.");
    }
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setUploadError(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
      return;
    }

    for (const file of supported.slice(0, room)) {
      const isImage = fileKind(file.name, file.type) === "image";
      const attachment: Attachment = {
        id: crypto.randomUUID(),
        kind: isImage ? "image" : "document",
        previewUrl: isImage ? URL.createObjectURL(file) : undefined,
        status: "uploading",
        mediaType: file.type,
        filename: file.name,
        info: isImage ? undefined : "Reading and indexing…",
      };
      setAttachments((prev) => [...prev, attachment]);

      const upload = isImage
        ? uploadImage(file).then((u) => ({ url: u.url, mediaType: u.mediaType, info: undefined }))
        : uploadDocument(file).then((u) => ({
            url: u.url,
            mediaType: u.mediaType,
            info: [
              u.pages ? `${u.pages} pages` : `${Math.round(u.chars / 1000)}k characters`,
              u.vectorStore === "pgvector" ? "indexed in pgvector" : u.embedded ? "indexed" : "keyword search only",
              u.truncated ? "very large: partly indexed" : "",
            ]
              .filter(Boolean)
              .join(" · "),
          }));

      upload
        .then((u) => updateAttachment(attachment.id, { status: "done", ...u }))
        .catch((err: Error) => {
          setUploadError(`${file.name}: ${err.message}`);
          updateAttachment(attachment.id, { status: "error", error: err.message, info: "Failed" });
        });
    }
  }

  function removeAttachment(attachmentId: string) {
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === attachmentId);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
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

    attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
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
          Drop images or documents to attach them
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
                Ask anything, attach images or documents (PDF, Word, Excel, code), or ask for an image or a file.
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
                {docsOf(m).length > 0 && (
                  <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
                    {docsOf(m).map((doc) => (
                      <a
                        key={doc.url}
                        href={doc.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:bg-muted"
                      >
                        <DocIcon name={doc.filename ?? ""} />
                        <span className="max-w-48 truncate">{doc.filename}</span>
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

                  // ----- Image generation -----
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
                    if (part.state === "output-error") return <ToolError key={i} label="Image generation failed" text={part.errorText} />;
                    return (
                      <div key={i} className="flex h-64 w-64 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground">
                        <Loader2 className="size-5 animate-spin" />
                        Generating image…
                      </div>
                    );
                  }

                  // ----- Document tools: show what the model did (agent steps) -----
                  if (part.type === "tool-searchDocuments") {
                    if (part.state === "output-error") return <ToolError key={i} label="Search failed" text={part.errorText} />;
                    return (
                      <ToolStep key={i} icon={<Search className="size-3.5" />} done={part.state === "output-available"}>
                        {part.state === "output-available"
                          ? `Searched documents for “${part.output.query}” · ${part.output.results.length} passages found${
                              part.output.searchedWith ? ` · ${part.output.searchedWith}` : ""
                            }`
                          : "Searching documents…"}
                      </ToolStep>
                    );
                  }
                  if (part.type === "tool-readDocument") {
                    if (part.state === "output-error") return <ToolError key={i} label="Reading failed" text={part.errorText} />;
                    return (
                      <ToolStep key={i} icon={<BookOpen className="size-3.5" />} done={part.state === "output-available"}>
                        {part.state === "output-available"
                          ? `Read “${part.output.document}” (parts ${part.output.fromPart}–${part.output.toPart} of ${part.output.totalParts})`
                          : "Reading document…"}
                      </ToolStep>
                    );
                  }
                  if (part.type === "tool-summarizeDocument") {
                    if (part.state === "output-error") return <ToolError key={i} label="Summary failed" text={part.errorText} />;
                    return (
                      <ToolStep key={i} icon={<ListChecks className="size-3.5" />} done={part.state === "output-available"}>
                        {part.state === "output-available"
                          ? `Summarized “${part.output.document}” in ${part.output.sections} section${part.output.sections > 1 ? "s" : ""} (${part.output.characters.toLocaleString()} characters)`
                          : "Summarizing the whole document… (large documents take a little while)"}
                      </ToolStep>
                    );
                  }
                  if (part.type === "tool-extractData") {
                    if (part.state === "output-error") return <ToolError key={i} label="Extraction failed" text={part.errorText} />;
                    if (part.state !== "output-available") {
                      return (
                        <ToolStep key={i} icon={<FileSpreadsheet className="size-3.5" />} done={false}>
                          Extracting structured data…
                        </ToolStep>
                      );
                    }
                    return <ExtractedData key={i} output={part.output} />;
                  }
                  if (part.type === "tool-analyzeTable") {
                    if (part.state === "output-error") return <ToolError key={i} label="Calculation failed" text={part.errorText} />;
                    if (part.state !== "output-available") {
                      return (
                        <ToolStep key={i} icon={<Calculator className="size-3.5" />} done={false}>
                          Calculating…
                        </ToolStep>
                      );
                    }
                    return (
                      <ExtractedData
                        key={i}
                        output={part.output}
                        title={`Calculated from “${part.output.document}” · ${part.output.matchedRows} of ${part.output.totalRows} rows used`}
                      />
                    );
                  }
                  if (part.type === "tool-createFile") {
                    if (part.state === "output-error") return <ToolError key={i} label="File creation failed" text={part.errorText} />;
                    if (part.state !== "output-available") {
                      return (
                        <ToolStep key={i} icon={<FileText className="size-3.5" />} done={false}>
                          Creating file…
                        </ToolStep>
                      );
                    }
                    return <FileCard key={i} file={part.output} />;
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
                  {a.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={a.previewUrl}
                      alt={a.filename}
                      className={`h-16 w-16 rounded-lg border object-cover ${a.status === "error" ? "border-destructive opacity-50" : "border-border"}`}
                    />
                  ) : (
                    <div
                      className={`flex h-16 w-56 items-center gap-2 rounded-lg border px-3 ${a.status === "error" ? "border-destructive opacity-60" : "border-border"}`}
                    >
                      <DocIcon name={a.filename} />
                      <div className="min-w-0">
                        <p className="truncate text-sm">{a.filename}</p>
                        <p className="truncate text-xs text-muted-foreground">{a.info}</p>
                      </div>
                    </div>
                  )}
                  {a.status === "uploading" && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                      <Loader2 className="size-4 animate-spin" />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label="Remove file"
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
              accept={ACCEPTED_FILES}
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
              aria-label="Attach images or documents"
              title="Attach images or documents"
              className="rounded-xl border border-border p-3 hover:bg-muted"
            >
              <Paperclip className="size-4" />
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
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
              placeholder="Message, or drop images and documents… (Shift+Enter for a new line)"
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

// ---------- Small display components ----------

function DocIcon({ name }: { name: string }) {
  const kind = fileKind(name);
  return kind === "spreadsheet" ? (
    <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" />
  ) : (
    <FileText className="size-5 shrink-0 text-muted-foreground" />
  );
}

// One agent step, e.g. "Searched documents for …"
function ToolStep({ icon, done, children }: { icon: React.ReactNode; done: boolean; children: React.ReactNode }) {
  return (
    <div className="flex w-fit items-center gap-2 rounded-lg bg-muted px-3 py-1.5 text-xs text-muted-foreground">
      {done ? icon : <Loader2 className="size-3.5 animate-spin" />}
      <span>{children}</span>
    </div>
  );
}

function ToolError({ label, text }: { label: string; text?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <p>
        {label}: {text}
      </p>
    </div>
  );
}

// A generated file with its download button
function FileCard({ file }: { file: CreatedFile }) {
  return (
    <div className="flex w-fit max-w-full items-center gap-3 rounded-xl border border-border px-4 py-3">
      <DocIcon name={file.filename} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{file.filename}</p>
        <p className="text-xs text-muted-foreground">
          {file.format.toUpperCase()} · {formatBytes(file.bytes)}
        </p>
      </div>
      <a
        href={file.downloadUrl}
        className="ml-2 flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
      >
        <Download className="size-3.5" /> Download
      </a>
    </div>
  );
}

type ExtractOutput = {
  document: string;
  columns: string[];
  rowCount: number;
  rows: Record<string, unknown>[];
  file?: CreatedFile;
};

// Extracted structured data: a table preview, the raw JSON, and an optional file
function ExtractedData({ output, title }: { output: ExtractOutput; title?: string }) {
  const preview = output.rows.slice(0, 10);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {title ? <Calculator className="size-3.5" /> : <FileSpreadsheet className="size-3.5" />}
        {title ?? `Extracted ${output.rowCount} record${output.rowCount === 1 ? "" : "s"} from “${output.document}”`}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {output.columns.map((c) => (
                <th key={c} className="border border-border bg-muted px-2 py-1 text-left font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.map((row, r) => (
              <tr key={r}>
                {output.columns.map((c) => (
                  <td key={c} className="border border-border px-2 py-1">
                    {row[c] === null || row[c] === undefined ? "—" : String(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {output.rowCount > preview.length && (
        <p className="text-xs text-muted-foreground">Showing {preview.length} of {output.rowCount} rows.</p>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Show JSON</summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-2">
          {JSON.stringify(output.rowCount === 1 ? output.rows[0] : output.rows, null, 2)}
        </pre>
      </details>
      {output.file && <FileCard file={output.file} />}
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
