import { generateText, Output, tool } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { generateAndStoreImage } from "@/lib/generate-image";
import { loadContent, searchDocuments } from "@/lib/documents";
import { createDownloadableFile, type Cell } from "@/lib/generate-file";
import { WORKER_MODEL } from "@/lib/models";
import { analyze, loadTables } from "@/lib/tables";

// Server-only: all the tools the chat model can decide to call.

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

export type ChatDocument = { url: string; name: string };

const MAX_READ_CHARS = 15_000; // how much text one readDocument call returns
const MAX_EXTRACT_CHARS = 150_000; // above this, extraction uses the most relevant parts only

export function buildTools(docs: ChatDocument[]) {
  // Find a document by (part of) its name
  function findDoc(name?: string) {
    if (!docs.length) throw new Error("No documents have been uploaded in this chat.");
    if (!name) return docs[docs.length - 1];
    const lower = name.toLowerCase();
    return (
      docs.find((d) => d.name.toLowerCase() === lower) ??
      docs.find((d) => d.name.toLowerCase().includes(lower) || lower.includes(d.name.toLowerCase())) ??
      (docs.length === 1 ? docs[0] : undefined) ??
      (() => {
        throw new Error(`Document "${name}" not found. Available: ${docs.map((d) => d.name).join(", ")}`);
      })()
    );
  }

  async function contentOf(name?: string) {
    const doc = findDoc(name);
    const content = await loadContent(doc.url);
    if (!content) throw new Error(`Could not load "${doc.name}".`);
    return content;
  }

  return {
    // ---------- Images (Project 3) ----------
    generateImage: tool({
      description:
        "Generate a new image from a text description, or edit / create a variation of existing images by passing them as references.",
      inputSchema: z.object({
        prompt: z.string().describe("Detailed description of the image to create, or of the final result after an edit."),
        referenceImageUrls: z
          .array(z.string())
          .max(3)
          .optional()
          .describe("URLs of existing images to edit, vary, or use as a style/content reference."),
        aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional().describe("Image shape. Leave empty for square."),
      }),
      execute: async (input) => generateAndStoreImage(input),
    }),

    // ---------- Documents: retrieval (RAG) ----------
    searchDocuments: tool({
      description:
        "Semantic search inside the uploaded documents. Use it to answer questions about large documents: it returns the most relevant passages.",
      inputSchema: z.object({
        query: z.string().describe("What to look for, phrased as a question or keywords."),
        documents: z.array(z.string()).optional().describe("Names of documents to search. Leave empty to search all."),
      }),
      execute: async ({ query, documents }) => {
        const selected = documents?.length ? documents.map((d) => findDoc(d)) : docs;
        const hits = await searchDocuments(selected, query, 8);
        return {
          query,
          results: hits.map((h) => ({
            document: h.document,
            part: h.chunk + 1,
            relevance: Math.round(h.score * 100) / 100,
            text: h.text,
          })),
        };
      },
    }),

    readDocument: tool({
      description:
        "Read the text of an uploaded document, part by part. Use it for large documents when you need a specific section, or to read a document in order.",
      inputSchema: z.object({
        document: z.string().describe("Name of the document."),
        fromPart: z.number().int().min(1).optional().describe("First part to read (1 = start of the document)."),
      }),
      execute: async ({ document, fromPart = 1 }) => {
        const content = await contentOf(document);
        let text = "";
        let part = fromPart - 1;
        while (part < content.chunks.length && text.length + content.chunks[part].length <= MAX_READ_CHARS) {
          text += content.chunks[part] + "\n\n";
          part++;
        }
        return {
          document: content.name,
          fromPart,
          toPart: part,
          totalParts: content.chunks.length,
          text: text.trim(),
          more: part < content.chunks.length ? `Continue with fromPart ${part + 1}.` : "End of document.",
        };
      },
    }),

    // ---------- Documents: long-document summary (map-reduce) ----------
    summarizeDocument: tool({
      description:
        "Summarize a whole document, even if it is much larger than your context window. Splits it into sections, summarizes each, then combines them.",
      inputSchema: z.object({
        document: z.string().describe("Name of the document."),
        focus: z.string().optional().describe("Optional focus, e.g. 'key financial figures' or 'risks'."),
      }),
      execute: async ({ document, focus }) => {
        const content = await contentOf(document);
        const perSection = Math.max(20, Math.ceil(content.chunks.length / 12)); // at most 12 sections
        const sections: string[] = [];
        for (let i = 0; i < content.chunks.length; i += perSection) {
          sections.push(content.chunks.slice(i, i + perSection).join("\n\n"));
        }

        // Map: summarize every section in parallel
        const partial = await Promise.all(
          sections.map(async (section, i) => {
            const { text } = await generateText({
              model: openrouter(WORKER_MODEL),
              maxOutputTokens: 700,
              prompt: `Summarize section ${i + 1} of ${sections.length} of the document "${content.name}"${
                focus ? `, focusing on: ${focus}` : ""
              }. Keep important facts, names and numbers. Use short bullet points.\n\n${section}`,
            });
            return text;
          })
        );

        // Reduce: combine the section summaries
        const summary =
          sections.length === 1
            ? partial[0]
            : (
                await generateText({
                  model: openrouter(WORKER_MODEL),
                  maxOutputTokens: 1500,
                  prompt: `These are summaries of consecutive sections of "${content.name}". Combine them into one well-structured summary${
                    focus ? ` focusing on: ${focus}` : ""
                  }, with headings and bullet points.\n\n${partial
                    .map((p, i) => `### Section ${i + 1}\n${p}`)
                    .join("\n\n")}`,
                })
              ).text;

        return { document: content.name, sections: sections.length, characters: content.chars, summary };
      },
    }),

    // ---------- Documents: structured extraction (schema-based output) ----------
    extractData: tool({
      description:
        "Extract structured data from a document (e.g. invoice fields, a table, a list of people or products) as validated JSON, and optionally save it as a spreadsheet. Do not use it to calculate totals or averages of spreadsheet data: use analyzeTable for that.",
      inputSchema: z.object({
        document: z.string().describe("Name of the document."),
        instructions: z.string().describe("What to extract, e.g. 'all line items of the invoice'."),
        fields: z
          .array(
            z.object({
              name: z.string().describe("Field name, e.g. 'invoice_number'."),
              type: z.enum(["string", "number", "boolean"]),
              description: z.string().optional(),
            })
          )
          .min(1)
          .max(25),
        multipleRows: z.boolean().describe("true for a list/table of items, false for one record (e.g. invoice header)."),
        saveAs: z.enum(["none", "xlsx", "csv", "json"]).optional().describe("Also create a downloadable file."),
      }),
      execute: async ({ document, instructions, fields, multipleRows, saveAs = "none" }) => {
        const content = await contentOf(document);
        const fullText = content.chunks.join("\n\n");
        const source =
          fullText.length <= MAX_EXTRACT_CHARS
            ? fullText
            : (await searchDocuments([findDoc(document)], instructions, 40)).map((h) => h.text).join("\n\n");

        // Build a Zod schema from the requested fields, so the model must return valid JSON
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const f of fields) {
          const base = f.type === "number" ? z.number() : f.type === "boolean" ? z.boolean() : z.string();
          shape[f.name] = base.nullable().describe(f.description ?? f.name);
        }
        const record = z.object(shape);
        const schema = multipleRows ? z.object({ rows: z.array(record) }) : record;

        const { output } = await generateText({
          model: openrouter(WORKER_MODEL),
          output: Output.object({ schema }),
          prompt: `Extract data from the document "${content.name}". Task: ${instructions}\nUse null when a value is missing. Do not invent values.\n\n${source}`,
        });

        const rows = (multipleRows ? (output as { rows: Record<string, Cell>[] }).rows : [output]) as Record<string, Cell>[];
        const columns = fields.map((f) => f.name);

        let file;
        if (saveAs === "xlsx" || saveAs === "csv") {
          file = await createDownloadableFile({
            format: saveAs,
            filename: `${content.name.replace(/\.\w+$/, "")}-extracted`,
            sheets: [{ name: "Extracted", columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)) }],
          });
        } else if (saveAs === "json") {
          file = await createDownloadableFile({
            format: "code",
            filename: `${content.name.replace(/\.\w+$/, "")}-extracted.json`,
            content: JSON.stringify(multipleRows ? rows : rows[0], null, 2),
          });
        }

        return { document: content.name, columns, rowCount: rows.length, rows: rows.slice(0, 200), file };
      },
    }),

    // ---------- Spreadsheets: exact calculations in code ----------
    analyzeTable: tool({
      description:
        "Calculate exact numbers from an Excel or CSV file: totals, averages, counts, minimum and maximum, optionally filtered and grouped (e.g. revenue per region). Always use this for any calculation on spreadsheet data instead of adding numbers yourself. Optionally saves the result as a spreadsheet.",
      inputSchema: z.object({
        document: z.string().describe("Name of the Excel or CSV document."),
        sheet: z.string().optional().describe("Sheet name (Excel). Leave empty for the first sheet."),
        filters: z
          .array(
            z.object({
              column: z.string(),
              operator: z.enum(["equals", "contains", "greater", "less"]),
              value: z.string().describe("Dates are YYYY-MM-DD text, so 'contains 2026-03' selects March 2026."),
            })
          )
          .optional(),
        groupBy: z.array(z.string()).optional().describe("Columns to group by, e.g. ['Region']. Leave empty for one overall result."),
        metrics: z
          .array(
            z.object({
              column: z.string().describe("Column to calculate on. Use '*' with count to count rows."),
              operation: z.enum(["sum", "average", "count", "min", "max"]),
            })
          )
          .min(1),
        sort: z.enum(["asc", "desc"]).optional().describe("Sort groups by the first metric."),
        limit: z.number().int().min(1).optional().describe("Keep only the first N groups (after sorting)."),
        saveAs: z.enum(["none", "xlsx", "csv"]).optional().describe("Also create a downloadable file with the result."),
      }),
      execute: async ({ document, sheet, saveAs = "none", ...query }) => {
        const doc = findDoc(document);
        const tables = await loadTables(doc.url, doc.name);
        const table = sheet
          ? tables.find((t) => t.name.toLowerCase() === sheet.toLowerCase()) ??
            (() => {
              throw new Error(`Sheet "${sheet}" not found. Sheets: ${tables.map((t) => t.name).join(", ")}`);
            })()
          : tables[0];

        const result = analyze(table, query);

        let file;
        if (saveAs !== "none") {
          file = await createDownloadableFile({
            format: saveAs,
            filename: `${doc.name.replace(/\.\w+$/, "")}-analysis`,
            sheets: [{ name: "Analysis", columns: result.columns, rows: result.rows.map((r) => result.columns.map((c) => r[c] ?? null)) }],
          });
        }

        return {
          document: doc.name,
          sheet: table.name,
          totalRows: table.rows.length,
          matchedRows: result.matchedRows,
          columns: result.columns,
          rowCount: result.rows.length,
          rows: result.rows.slice(0, 200),
          file,
        };
      },
    }),

    // ---------- File generation ----------
    createFile: tool({
      description:
        "Create a downloadable file: Word (.docx), PDF, Excel (.xlsx), CSV, Markdown, text, or a code file. Use it whenever the user wants a file, or wants an uploaded file edited and returned.",
      inputSchema: z.object({
        format: z.enum(["docx", "pdf", "xlsx", "csv", "md", "txt", "code"]),
        filename: z.string().describe("File name, e.g. 'report.docx' or 'script.py'."),
        title: z.string().optional().describe("Optional document title (docx/pdf)."),
        content: z
          .string()
          .optional()
          .describe("For docx/pdf: the full content in Markdown (# headings, - bullets, **bold**, | tables |). For md/txt/code: the raw file content."),
        sheets: z
          .array(
            z.object({
              name: z.string(),
              columns: z.array(z.string()),
              rows: z.array(z.array(z.string())).describe("Cell values as text; numbers are converted automatically."),
            })
          )
          .optional()
          .describe("For xlsx/csv: one or more tables."),
      }),
      execute: async ({ sheets, ...input }) =>
        createDownloadableFile({
          ...input,
          sheets: sheets?.map((s) => ({
            ...s,
            rows: s.rows.map((r) => r.map((v) => (/^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v))),
          })),
        }),
    }),
  };
}

export type ChatTools = ReturnType<typeof buildTools>;
