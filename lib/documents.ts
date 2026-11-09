import { put } from "@vercel/blob";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { extensionOf, type FileKind } from "@/lib/files";

// Server-only helpers for documents: parsing, chunking, embeddings (RAG) and storage in Vercel Blob.

export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 512; // smaller vectors = smaller files and faster search
const CHUNK_SIZE = 1200; // characters per chunk
const CHUNK_OVERLAP = 150; // characters shared between neighbouring chunks
const MAX_INDEX_CHARS = 1_500_000; // about 400k tokens, far more than most models can read at once

export type DocumentContent = {
  name: string;
  kind: FileKind;
  chars: number;
  pages?: number;
  truncated: boolean;
  chunks: string[];
};

// ---------- 1. Parsing: turn a file into plain text ----------

export async function parseDocument(bytes: Buffer, filename: string, kind: FileKind) {
  let text = "";
  let pages: number | undefined;

  if (kind === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(pdf, { mergePages: false });
    pages = result.totalPages;
    text = result.text.map((pageText, i) => `[Page ${i + 1}]\n${pageText.trim()}`).join("\n\n");
    const realText = result.text.join("").replace(/\s/g, "");
    if (realText.length < 20 * Math.max(1, pages)) {
      throw new Error(
        "This PDF has almost no selectable text. It's probably scanned. Take screenshots of the pages and upload them as images instead."
      );
    }
  } else if (kind === "docx") {
    // Convert to HTML first, so headings, lists and tables keep their structure
    const result = await mammoth.convertToHtml({ buffer: bytes });
    text = htmlToText(result.value);
  } else if (kind === "spreadsheet" && extensionOf(filename) === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    const sheets: string[] = [];
    workbook.eachSheet((sheet) => {
      const rows: string[] = [];
      sheet.eachRow((row) => {
        const values = (row.values as unknown[]).slice(1).map((v) => cellText(v));
        rows.push(values.join(" | "));
      });
      sheets.push(`## Sheet: ${sheet.name} (${rows.length} rows)\n${rows.join("\n")}`);
    });
    text = sheets.join("\n\n");
  } else if (kind === "code") {
    text = "```" + extensionOf(filename) + "\n" + bytes.toString("utf8") + "\n```";
  } else {
    // text, markdown and CSV
    text = bytes.toString("utf8");
  }

  text = text.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!text) throw new Error("No text could be extracted from this file.");
  return { text, pages };
}

// Minimal HTML → Markdown-like text (headings, lists, tables as "a | b | c")
function htmlToText(html: string) {
  return html
    .replace(/<(t[dh])([^>]*)>\s*<p>/g, "<$1$2>") // paragraphs inside table cells
    .replace(/<\/p>\s*<\/(t[dh])>/g, "</$1>")
    .replace(/<\/p>\s*<p>(?=[^<]*<\/t[dh]>)/g, " ")
    .replace(/<h([1-6])[^>]*>/g, (_, level) => "\n" + "#".repeat(Number(level)) + " ")
    .replace(/<li[^>]*>/g, "\n- ")
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/g, " | ")
    .replace(/<\/tr>/g, "\n")
    .replace(/<\/(p|h[1-6]|table|ul|ol)>/g, "\n\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n");
}

// Reads one Excel cell, including formulas, links and dates
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (v.richText) return v.richText.map((r) => r.text).join("");
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return String(v.text);
    return JSON.stringify(value);
  }
  return String(value);
}

// ---------- 2. Chunking: split long text into overlapping pieces ----------

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      // Prefer to cut at a paragraph or line break, so chunks stay readable
      const breakAt = Math.max(text.lastIndexOf("\n\n", end), text.lastIndexOf("\n", end));
      if (breakAt > start + CHUNK_SIZE / 2) end = breakAt;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks.filter(Boolean);
}

// ---------- 3. Embeddings: turn text into vectors for semantic search ----------

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += 100) batches.push(texts.slice(i, i + 100));

  const results: number[][][] = [];
  // Send 4 batches at a time to stay fast without hitting rate limits
  for (let i = 0; i < batches.length; i += 4) {
    const group = await Promise.all(batches.slice(i, i + 4).map(embedBatch));
    results.push(...group);
  }
  return results.flat();
}

async function embedBatch(input: string[]): Promise<number[][]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input, dimensions: EMBEDDING_DIMENSIONS }),
  });
  if (!res.ok) throw new Error(`Embedding request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.data as { embedding: number[]; index: number }[])
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding.map((x) => Math.round(x * 1e5) / 1e5));
}

function similarity(a: number[], b: number[]) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

// ---------- 4. Storage in Vercel Blob ----------
// Each document gets its own folder: docs/<id>/<original file>, content.json, vectors.json

export async function saveDocument(file: File, kind: FileKind) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const { text, pages } = await parseDocument(bytes, file.name, kind);

  const truncated = text.length > MAX_INDEX_CHARS;
  const chunks = chunkText(truncated ? text.slice(0, MAX_INDEX_CHARS) : text);

  const id = crypto.randomUUID();
  const safeName = file.name.replace(/[^\w.-]/g, "_") || "document";
  const folder = `docs/${id}`;

  const original = await put(`${folder}/${safeName}`, bytes, {
    access: "public",
    addRandomSuffix: false,
    contentType: file.type || "application/octet-stream",
  });

  const content: DocumentContent = { name: file.name, kind, chars: text.length, pages, truncated, chunks };
  await put(`${folder}/content.json`, JSON.stringify(content), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });

  // Embeddings are optional: if they fail, search falls back to keyword matching
  let embedded = false;
  try {
    const vectors = await embedTexts(chunks);
    await put(`${folder}/vectors.json`, JSON.stringify(vectors), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
    });
    embedded = true;
  } catch (err) {
    console.error("Embedding failed, keyword search will be used instead:", err);
  }

  return { url: original.url, chars: text.length, pages, chunks: chunks.length, truncated, embedded };
}

const BLOB_HOST = /\.public\.blob\.vercel-storage\.com$/;
const cache = new Map<string, unknown>();

// docs/<id>/report.pdf → docs/<id>/content.json
function siblingUrl(fileUrl: string, name: string) {
  const parsed = new URL(fileUrl);
  if (parsed.protocol !== "https:" || !BLOB_HOST.test(parsed.hostname)) throw new Error("Unknown document location.");
  return fileUrl.slice(0, fileUrl.lastIndexOf("/") + 1) + name;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  if (cache.has(url)) return cache.get(url) as T;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as T;
  cache.set(url, data);
  return data;
}

export async function loadContent(fileUrl: string) {
  return fetchJson<DocumentContent>(siblingUrl(fileUrl, "content.json"));
}

async function loadVectors(fileUrl: string) {
  return fetchJson<number[][]>(siblingUrl(fileUrl, "vectors.json"));
}

// ---------- 5. Retrieval (the "R" in RAG) ----------

export type SearchHit = { document: string; chunk: number; score: number; text: string };

export async function searchDocuments(
  docs: { url: string; name: string }[],
  query: string,
  topK = 8
): Promise<SearchHit[]> {
  let queryVector: number[] | null = null;
  try {
    [queryVector] = await embedTexts([query]);
  } catch {
    queryVector = null;
  }
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);

  const hits: SearchHit[] = [];
  for (const doc of docs) {
    const content = await loadContent(doc.url);
    if (!content) continue;
    const vectors = queryVector ? await loadVectors(doc.url) : null;

    content.chunks.forEach((text, i) => {
      let score: number;
      if (queryVector && vectors?.[i]) {
        score = similarity(queryVector, vectors[i]);
      } else {
        // Fallback: count matching words
        const lower = text.toLowerCase();
        score = words.reduce((sum, w) => sum + (lower.includes(w) ? 1 : 0), 0) / (words.length || 1);
      }
      hits.push({ document: content.name, chunk: i, score, text });
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, topK);
}
