import { Routes } from "discord.js";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import { guildOf, rest } from "../discord.ts";
import { DESTRUCTIVE, READ, WRITE, def, guildId } from "../tool.ts";

const FORMAT: Record<number, string> = { 1: "png", 2: "apng", 3: "lottie", 4: "gif" };

def("list_stickers", {
  description: "List custom stickers (ID, name, tags, format).",
  inputSchema: { guildId },
  annotations: READ,
}, async (a) =>
  ((await rest().get(Routes.guildStickers(guildOf(a.guildId)))) as { id: string; name: string; tags?: string; format_type: number }[])
    .map((s) => `${s.name} ${s.id} [${FORMAT[s.format_type] ?? s.format_type}] tags=${s.tags ?? "-"}`).join("\n") || "(no custom stickers)");

def("create_sticker", {
  description:
    "Add a custom sticker from a PNG, APNG, GIF or Lottie JSON file (URL or absolute path). Discord limits it to 512 KB and 320x320 px. " +
    "tags is the emoji name that suggests the sticker (e.g. \"wave\"). Needs Create Expressions and a server with a free sticker slot.",
  inputSchema: {
    guildId, name: z.string().min(2).max(30), description: z.string().max(100).optional(),
    tags: z.string().min(2).max(200), file: z.string().describe("URL or absolute file path"),
  },
  annotations: WRITE,
}, async (a) => {
  let data: Buffer, ext: string;
  if (/^https?:\/\//.test(a.file)) {
    const r = await fetch(a.file);
    if (!r.ok) throw new Error(`Could not download the file (${r.status})`);
    data = Buffer.from(await r.arrayBuffer());
    ext = extname(new URL(a.file).pathname).toLowerCase();
  } else {
    data = await readFile(a.file);
    ext = extname(a.file).toLowerCase();
  }
  if (![".png", ".apng", ".gif", ".json"].includes(ext)) throw new Error("Unsupported file type (use png, apng, gif or json).");
  if (data.length > 512 * 1024) throw new Error(`The file is ${(data.length / 1024).toFixed(0)} KB; Discord accepts at most 512 KB.`);
  const s = (await rest().post(Routes.guildStickers(guildOf(a.guildId)), {
    body: { name: a.name, description: a.description ?? "", tags: a.tags },
    files: [{ name: basename(a.file) || `sticker${ext}`, data, key: "file" }],
    appendToFormData: true,
  })) as { id: string; name: string };
  return `Created: ${s.name} ${s.id}`;
});

def("delete_sticker", {
  description: "Delete a custom sticker.",
  inputSchema: { guildId, stickerId: z.string() },
  annotations: DESTRUCTIVE,
}, async (a) => {
  await rest().delete(Routes.guildSticker(guildOf(a.guildId), a.stickerId));
  return "Deleted";
});
