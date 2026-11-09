import ExcelJS from "exceljs";
import { extensionOf } from "@/lib/files";
import type { Cell } from "@/lib/generate-file";

// Server-only: exact calculations on spreadsheets and CSV files.
// Language models are bad at adding up many numbers, so totals, averages and counts are computed here in code.

export type Table = { name: string; columns: string[]; rows: Cell[][] };

export type Filter = { column: string; operator: "equals" | "contains" | "greater" | "less"; value: string };
export type Metric = { column: string; operation: "sum" | "average" | "count" | "min" | "max" };

const BLOB_HOST = /\.public\.blob\.vercel-storage\.com$/;
const cache = new Map<string, Table[]>();

// Downloads the original uploaded file from Blob and reads every sheet as a table
export async function loadTables(fileUrl: string, filename: string): Promise<Table[]> {
  if (cache.has(fileUrl)) return cache.get(fileUrl)!;
  const parsed = new URL(fileUrl);
  if (parsed.protocol !== "https:" || !BLOB_HOST.test(parsed.hostname)) throw new Error("Unknown document location.");

  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Could not download "${filename}".`);
  const bytes = Buffer.from(await res.arrayBuffer());

  const ext = extensionOf(filename);
  let tables: Table[];
  if (ext === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    tables = [];
    workbook.eachSheet((sheet) => {
      const rows: Cell[][] = [];
      sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map(toCell)));
      if (rows.length) tables.push(makeTable(sheet.name, rows));
    });
  } else if (ext === "csv" || ext === "tsv") {
    const rows = parseCsv(bytes.toString("utf8"), ext === "tsv" ? "\t" : ",").map((r) => r.map(toCell));
    tables = [makeTable(filename, rows)];
  } else {
    throw new Error("analyzeTable only works on Excel (.xlsx) and CSV files. For other documents use extractData.");
  }
  if (!tables.length) throw new Error(`"${filename}" has no data.`);
  cache.set(fileUrl, tables);
  return tables;
}

// First row = column names, the rest = data
function makeTable(name: string, rows: Cell[][]): Table {
  const columns = (rows[0] ?? []).map((c, i) => (c === null || c === "" ? `Column ${i + 1}` : String(c)));
  const data = rows.slice(1).filter((r) => r.some((c) => c !== null && c !== ""));
  return { name, columns, rows: data.map((r) => columns.map((_, i) => r[i] ?? null)) };
}

// Reads one Excel/CSV value: formulas use their result, dates become YYYY-MM-DD, numeric text becomes a number
function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "object") {
    const v = value as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (v.richText) return v.richText.map((r) => r.text).join("");
    if (v.result !== undefined) return toCell(v.result);
    if (v.text !== undefined) return String(v.text);
    return null;
  }
  const text = String(value).trim();
  const number = Number(text.replace(/,/g, ""));
  return text !== "" && !Number.isNaN(number) && /^-?[\d,]*\.?\d+$/.test(text) ? number : text;
}

// Small CSV parser that handles quoted values ("a, b") and escaped quotes ("")
function parseCsv(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) {
      row.push(value);
      value = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else value += ch;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

// ---------- The calculation ----------

export function analyze(
  table: Table,
  { filters = [], groupBy = [], metrics, sort, limit }: {
    filters?: Filter[];
    groupBy?: string[];
    metrics: Metric[];
    sort?: "asc" | "desc";
    limit?: number;
  }
) {
  // Find columns by name, ignoring upper/lower case
  const index = (name: string) => {
    if (name === "*") return -1;
    const i = table.columns.findIndex((c) => c.toLowerCase().trim() === name.toLowerCase().trim());
    if (i === -1) throw new Error(`Column "${name}" not found. Available columns: ${table.columns.join(", ")}`);
    return i;
  };

  // 1. Filter rows
  let rows = table.rows;
  for (const f of filters) {
    const i = index(f.column);
    rows = rows.filter((r) => {
      const cell = r[i];
      const text = String(cell ?? "").toLowerCase();
      const target = f.value.toLowerCase();
      if (f.operator === "equals") return text === target;
      if (f.operator === "contains") return text.includes(target);
      const a = typeof cell === "number" ? cell : Number(cell);
      const b = Number(f.value);
      if (Number.isNaN(a) || Number.isNaN(b)) return f.operator === "greater" ? text > target : text < target;
      return f.operator === "greater" ? a > b : a < b;
    });
  }

  // 2. Group rows
  const groupIdx = groupBy.map(index);
  const groups = new Map<string, Cell[][]>();
  for (const r of rows) {
    const key = JSON.stringify(groupIdx.map((i) => r[i]));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  if (!groups.size && !groupIdx.length) groups.set("[]", []);

  // 3. Compute each metric per group
  const metricName = (m: Metric) => (m.operation === "count" && m.column === "*" ? "count" : `${m.operation} of ${m.column}`);
  const columns = [...groupBy.map((g, n) => table.columns[groupIdx[n]] ?? g), ...metrics.map(metricName)];

  let result = [...groups.entries()].map(([key, groupRows]) => {
    const out: Record<string, Cell> = {};
    (JSON.parse(key) as Cell[]).forEach((v, n) => (out[columns[n]] = v));
    for (const m of metrics) {
      const i = index(m.column);
      const values = i === -1 ? groupRows.map(() => 1) : groupRows.map((r) => r[i]);
      const numbers = values.filter((v): v is number => typeof v === "number");
      let value: number | null;
      if (m.operation === "count") value = i === -1 ? groupRows.length : values.filter((v) => v !== null && v !== "").length;
      else if (!numbers.length) value = null;
      else if (m.operation === "sum") value = numbers.reduce((a, b) => a + b, 0);
      else if (m.operation === "average") value = numbers.reduce((a, b) => a + b, 0) / numbers.length;
      else if (m.operation === "min") value = Math.min(...numbers);
      else value = Math.max(...numbers);
      out[metricName(m)] = value === null ? null : Math.round(value * 100) / 100;
    }
    return out;
  });

  // 4. Sort by the first metric and keep the top N
  if (sort) {
    const by = metricName(metrics[0]);
    result.sort((a, b) => ((Number(a[by]) || 0) - (Number(b[by]) || 0)) * (sort === "asc" ? 1 : -1));
  }
  if (limit) result = result.slice(0, limit);

  return { matchedRows: rows.length, columns, rows: result };
}
