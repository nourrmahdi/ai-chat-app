import { put } from "@vercel/blob";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

// Server-only: turns AI output (Markdown text or table rows) into real downloadable files.

export type FileFormat = "docx" | "pdf" | "xlsx" | "csv" | "md" | "txt" | "code";
export type Cell = string | number | boolean | null;
export type Sheet = { name: string; columns: string[]; rows: Cell[][] };

export type CreateFileInput = {
  format: FileFormat;
  filename: string;
  title?: string;
  content?: string; // Markdown for docx/pdf, raw text for md/txt/code
  sheets?: Sheet[]; // tables for xlsx/csv
};

export type CreatedFile = {
  url: string;
  downloadUrl: string;
  filename: string;
  format: FileFormat;
  bytes: number;
};

const CONTENT_TYPES: Record<FileFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
  code: "text/plain",
};

export async function createDownloadableFile(input: CreateFileInput): Promise<CreatedFile> {
  const filename = withExtension(input.filename || "file", input.format);
  let bytes: Buffer;

  switch (input.format) {
    case "docx":
      bytes = await buildDocx(input.title, input.content ?? "");
      break;
    case "pdf":
      bytes = await buildPdf(input.title, input.content ?? "");
      break;
    case "xlsx":
      bytes = await buildXlsx(input.sheets ?? tableFromText(input.content));
      break;
    case "csv":
      bytes = Buffer.from(toCsv((input.sheets ?? tableFromText(input.content))[0]), "utf8");
      break;
    default:
      bytes = Buffer.from(input.content ?? "", "utf8");
  }

  const blob = await put(`generated/${crypto.randomUUID()}/${filename}`, bytes, {
    access: "public",
    addRandomSuffix: false,
    contentType: CONTENT_TYPES[input.format],
  });

  return { url: blob.url, downloadUrl: blob.downloadUrl, filename, format: input.format, bytes: bytes.length };
}

function withExtension(name: string, format: FileFormat) {
  const clean = name.replace(/[^\w.\- ]/g, "_").trim() || "file";
  if (format === "code") return clean.includes(".") ? clean : `${clean}.txt`;
  return clean.toLowerCase().endsWith(`.${format}`) ? clean : `${clean.replace(/\.\w+$/, "")}.${format}`;
}

// ---------- Word (.docx) from Markdown ----------

export async function buildDocx(title: string | undefined, markdown: string) {
  const children: (Paragraph | Table)[] = [];
  if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));

  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Markdown table: collect consecutive "| a | b |" lines
    if (line.trim().startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) tableLines.push(lines[i++]);
      i--;
      const rows = tableLines
        .filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l))
        .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      if (rows.length) {
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: rows.map(
              (cells, r) =>
                new TableRow({
                  children: cells.map(
                    (c) => new TableCell({ children: [new Paragraph({ children: inlineRuns(c, r === 0) })] })
                  ),
                })
            ),
          })
        );
      }
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)/);
    if (heading) {
      const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][heading[1].length - 1];
      children.push(new Paragraph({ heading: level, children: inlineRuns(heading[2]) }));
    } else if (/^\s*[-*]\s+/.test(line)) {
      children.push(new Paragraph({ bullet: { level: 0 }, children: inlineRuns(line.replace(/^\s*[-*]\s+/, "")) }));
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      children.push(new Paragraph({ children: inlineRuns(line.trim()) }));
    } else {
      children.push(new Paragraph({ children: inlineRuns(line) }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

// "**bold** and *italic*" → formatted text runs
function inlineRuns(text: string, allBold = false): TextRun[] {
  return text
    .split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g)
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith("**") && part.endsWith("**")) return new TextRun({ text: part.slice(2, -2), bold: true });
      if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
        return new TextRun({ text: part.slice(1, -1), italics: true, bold: allBold });
      return new TextRun({ text: part, bold: allBold });
    });
}

// ---------- PDF from Markdown ----------

export async function buildPdf(title: string | undefined, markdown: string) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 50;
  const pageWidth = 595; // A4
  const pageHeight = 842;
  const maxWidth = pageWidth - margin * 2;

  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const write = (text: string, font: PDFFont, size: number, indent = 0) => {
    for (const line of wrap(safeText(text), font, size, maxWidth - indent)) {
      if (y < margin + size) {
        page = pdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      page.drawText(line, { x: margin + indent, y, size, font, color: rgb(0.1, 0.1, 0.1) });
      y -= size * 1.4;
    }
  };

  // Draws a Markdown table as aligned columns with light borders
  const drawTable = (rows: string[][]) => {
    const cols = Math.max(...rows.map((r) => r.length));
    const colWidth = maxWidth / cols;
    const size = 10;
    const rowHeight = size * 1.9;
    rows.forEach((cells, r) => {
      if (y < margin + rowHeight) {
        page = pdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      const font = r === 0 ? bold : regular;
      if (r === 0) {
        page.drawRectangle({ x: margin, y: y - size * 0.6, width: maxWidth, height: rowHeight, color: rgb(0.93, 0.93, 0.93) });
      }
      cells.forEach((cell, c) => {
        let text = safeText(cell);
        while (text.length > 1 && font.widthOfTextAtSize(text, size) > colWidth - 8) text = text.slice(0, -2) + "…";
        page.drawText(text, { x: margin + c * colWidth + 4, y, size, font, color: rgb(0.1, 0.1, 0.1) });
      });
      page.drawLine({
        start: { x: margin, y: y - size * 0.6 },
        end: { x: margin + maxWidth, y: y - size * 0.6 },
        thickness: 0.5,
        color: rgb(0.8, 0.8, 0.8),
      });
      y -= rowHeight;
    });
    y -= 6;
  };

  if (title) {
    write(title, bold, 20);
    y -= 8;
  }
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\*\*/g, "").replace(/\*([^*]+)\*/g, "$1");

    // Markdown table: collect consecutive "| a | b |" lines
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const l = lines[i++].replace(/\*\*/g, "");
        if (!/^\s*\|?\s*:?-{2,}/.test(l)) rows.push(l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      }
      i--;
      if (rows.length) drawTable(rows);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)/);
    if (heading) {
      y -= 6;
      write(heading[2], bold, [16, 14, 12][heading[1].length - 1]);
    } else if (/^\s*[-*]\s+/.test(line)) {
      write("•  " + line.replace(/^\s*[-*]\s+/, ""), regular, 11, 10);
    } else if (!line.trim()) {
      y -= 8;
    } else if (!/^\s*\|?\s*:?-{3,}/.test(line)) {
      write(line.replace(/^\||\|$/g, "").replace(/\|/g, "   "), regular, 11);
    }
  }
  return Buffer.from(await pdf.save());
}

// The built-in PDF fonts only support Latin characters
function safeText(text: string) {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF•]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number) {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const test = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

// ---------- Excel (.xlsx) and CSV ----------

export async function buildXlsx(sheets: Sheet[]) {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets.length ? sheets : [{ name: "Sheet1", columns: [], rows: [] }]) {
    const ws = workbook.addWorksheet((sheet.name || "Sheet").slice(0, 31));
    ws.addRow(sheet.columns);
    ws.getRow(1).font = { bold: true };
    sheet.rows.forEach((row) => ws.addRow(row));
    ws.columns.forEach((col, i) => {
      const longest = Math.max(
        String(sheet.columns[i] ?? "").length,
        ...sheet.rows.map((r) => String(r[i] ?? "").length)
      );
      col.width = Math.min(Math.max(longest + 2, 10), 60);
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function toCsv(sheet: Sheet | undefined) {
  if (!sheet) return "";
  const escape = (v: Cell) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [sheet.columns, ...sheet.rows].map((r) => r.map(escape).join(",")).join("\n");
}

// If the model sends a Markdown table as text instead of rows, convert it
function tableFromText(text = ""): Sheet[] {
  const lines = text.split("\n").filter((l) => l.includes("|") && !/^\s*\|?\s*:?-{3,}/.test(l));
  const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  return [{ name: "Sheet1", columns: rows[0] ?? [], rows: rows.slice(1) }];
}
