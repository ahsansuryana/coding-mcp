import dotenv from "dotenv";
dotenv.config({ quiet: true }); // tanpa log ke stdout

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { exec } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// ---------- config ----------

const WORKDIR = path.resolve(process.env.WORKDIR ?? "./workspace");
const TOKEN = process.env.MCP_TOKEN;
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const SHELL = process.env.SHELL_PATH; // undefined = shell default sistem
const MAX_OUT = 30_000;
const MAX_VIEW = 16_000;

if (!TOKEN || TOKEN.length < 16) {
  console.error("MCP_TOKEN belum di-set atau terlalu pendek (minimal 16 karakter)");
  process.exit(1);
}
if (SHELL && !existsSync(SHELL)) {
  console.error(`SHELL_PATH tidak ditemukan: ${SHELL}`);
  process.exit(1);
}

// ---------- helper ----------

// Jaga agar path tool file tidak keluar dari WORKDIR
function safe(p: string) {
  const full = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, full);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("Path di luar WORKDIR");
  return full;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });

// bash_tool: potong dari belakang
const trunc = (s: string) =>
  s.length > MAX_OUT ? s.slice(0, MAX_OUT) + "\n...[dipotong]" : s;

// view: potong dari tengah, sisakan awal dan akhir
function truncMiddle(s: string) {
  if (s.length <= MAX_VIEW) return s;
  const half = Math.floor(MAX_VIEW / 2);
  return s.slice(0, half) + "\n...[dipotong di tengah]...\n" + s.slice(-half);
}

// view: direktori sampai 2 level, abaikan hidden dan node_modules
async function listDir(dir: string, depth = 0): Promise<string[]> {
  const out: string[] = [];
  const items = await fs.readdir(dir, { withFileTypes: true });
  for (const i of items) {
    if (i.name.startsWith(".") || i.name === "node_modules") continue;
    const pad = "  ".repeat(depth);
    if (i.isDirectory()) {
      out.push(`${pad}${i.name}/`);
      if (depth < 1) out.push(...(await listDir(path.join(dir, i.name), depth + 1)));
    } else {
      out.push(`${pad}${i.name}`);
    }
  }
  return out;
}

// ---------- server MCP ----------

function buildServer() {
  const server = new McpServer({ name: "coding-mcp", version: "0.1.0" });

  server.tool(
    "bash_tool",
    "Run a bash command on the server",
    {
      command: z.string().describe("Bash command to run on the server"),
      description: z.string().describe("Why I'm running this command"),
    },
    async ({ command }) =>
      new Promise((resolve) => {
        exec(
          command,
          { cwd: WORKDIR, timeout: 60_000, maxBuffer: 5 * 1024 * 1024, shell: SHELL },
          (err, stdout, stderr) => {
            const code = (err as any)?.code ?? 0;
            const out = `exit: ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
            resolve(err ? fail(trunc(out)) : text(trunc(out)));
          }
        );
      })
  );

  server.tool(
    "create_file",
    "Create a new file with content on the server. Fails if the path already exists — use str_replace to edit an existing file, or bash_tool (cat > path << 'EOF') to overwrite it.",
    {
      description: z.string().describe("Why I'm creating this file. ALWAYS PROVIDE THIS PARAMETER FIRST."),
      path: z.string().describe("Path to the file to create. ALWAYS PROVIDE THIS PARAMETER SECOND."),
      file_text: z.string().describe("Content to write to the file. ALWAYS PROVIDE THIS PARAMETER LAST."),
    },
    async ({ path: p, file_text }) => {
      try {
        const full = safe(p);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, file_text, { flag: "wx" }); // wx = gagal kalau sudah ada
        return text(`Dibuat: ${p}`);
      } catch (e: any) {
        return fail(e.code === "EEXIST" ? `Sudah ada: ${p}` : e.message);
      }
    }
  );

  server.tool(
    "str_replace",
    "Replace a unique string in a file with another string. old_str must match the raw file content exactly and appear exactly once. When copying from view output, do NOT include the line number prefix (spaces + line number + tab) — it is display-only. View the file immediately before editing; after any successful str_replace, earlier view output of that file in your context is stale — re-view before further edits to the same file.",
    {
      path: z.string().describe("Path to the file to edit"),
      description: z.string().describe("REQUIRED. Why I'm making this edit"),
      old_str: z.string().describe("String to replace (must be unique in file)"),
      new_str: z.string().default("").describe("String to replace with (empty to delete)"),
    },
    async ({ path: p, old_str, new_str }) => {
      try {
        const full = safe(p);
        const src = await fs.readFile(full, "utf8");
        const count = src.split(old_str).length - 1;
        if (count === 0) return fail("old_str tidak ditemukan");
        if (count > 1) return fail(`old_str muncul ${count}x, harus unik`);
        await fs.writeFile(full, src.replace(old_str, () => new_str)); // fungsi: hindari pola $& dll
        return text("OK");
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  server.tool(
    "view",
    `Supports viewing text, images, and directory listings.

Supported path types:
- Directories: Lists files and directories up to 2 levels deep, ignoring hidden items and node_modules
- Image files (.jpg, .jpeg, .png, .gif, .webp): Displays the image visually
- Text files: Displays numbered lines (prefix \`    N\\t\` is display-only — do not include it in str_replace's \`old_str\`). You can optionally specify a view_range to see specific lines.

Note: Files with non-UTF-8 encoding will display hex escapes (e.g. \\x84) for invalid bytes`,
    {
      description: z.string().describe("Why I need to view this"),
      path: z
        .string()
        .describe("Path to file or directory, relative to the server workspace (e.g. `src/app.ts`, or `.` for the root)."),
      view_range: z
        .tuple([z.number().int(), z.number().int()])
        .nullable()
        .optional()
        .describe(
          "Optional line range for text files. Format: [start_line, end_line] where lines are indexed starting at 1. Use [start_line, -1] to view from start_line to the end of the file. When not provided, the entire file is displayed, truncating from the middle if it exceeds 16,000 characters (showing beginning and end)."
        ),
    },
    async ({ path: p, view_range }) => {
      try {
        const full = safe(p);
        const st = await fs.stat(full);

        if (st.isDirectory()) return text((await listDir(full)).join("\n"));

        const ext = path.extname(full).slice(1).toLowerCase();
        const mime: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
        };
        if (mime[ext]) {
          const data = (await fs.readFile(full)).toString("base64");
          return { content: [{ type: "image" as const, data, mimeType: mime[ext] }] };
        }

        let lines = (await fs.readFile(full, "utf8")).split("\n");
        let start = 1;
        if (view_range) {
          const [a, b] = view_range;
          start = a;
          lines = lines.slice(a - 1, b === -1 ? undefined : b);
        }
        const numbered = lines
          .map((l, i) => `${String(start + i).padStart(6)}\t${l}`)
          .join("\n");
        return text(view_range ? numbered : truncMiddle(numbered));
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  return server;
}

// ---------- HTTP ----------

const app = express();
app.use(express.json({ limit: "10mb" }));

// Tidak ada endpoint discovery OAuth, supaya klien tidak mencoba alur OAuth
app.use("/.well-known", (_req, res) => res.status(404).end());

// Auth header bearer, wajib karena ada bash_tool
const EXPECTED = Buffer.from(`Bearer ${TOKEN}`);
app.use("/mcp", (req, res, next) => {
  const got = Buffer.from(req.headers.authorization ?? "");
  const ok = got.length === EXPECTED.length && timingSafeEqual(got, EXPECTED);
  if (!ok) {
    res.set("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// Stateless: server + transport baru tiap request
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (_req, res) => res.status(405).end());
app.delete("/mcp", (_req, res) => res.status(405).end());

await fs.mkdir(WORKDIR, { recursive: true });
app.listen(PORT, HOST, () => console.log(`http://${HOST}:${PORT}/mcp`));
