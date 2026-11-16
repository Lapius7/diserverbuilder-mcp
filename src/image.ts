import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".json": "application/json" };

/** Read an image from a URL or local path as a data URI. `allow` lists accepted MIME prefixes. */
export async function toDataUri(src: string, allow: string[] = ["image/"]): Promise<string> {
  if (src.startsWith("data:")) return src;
  let bytes: Buffer, mime: string | undefined;
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`Could not download the image (${r.status})`);
    bytes = Buffer.from(await r.arrayBuffer());
    mime = r.headers.get("content-type")?.split(";")[0] ?? MIME[extname(new URL(src).pathname).toLowerCase()];
  } else {
    bytes = await readFile(src);
    mime = MIME[extname(src).toLowerCase()];
  }
  if (!mime || !allow.some((a) => mime!.startsWith(a))) throw new Error("Unsupported file type (use png, jpg, gif or webp)");
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
