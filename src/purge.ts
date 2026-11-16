export interface PurgeMsg { id: string; author: { id: string; bot?: boolean }; content: string; pinned?: boolean }
export interface PurgeFilter { fromUserId?: string; contains?: string; onlyBots?: boolean; includePinned?: boolean }

const EPOCH = 1420070400000;
/** Discord refuses to bulk-delete messages older than 14 days. */
export const BULK_MAX_AGE_MS = 14 * 24 * 3600 * 1000 - 60_000;
export const ageMs = (id: string, now = Date.now()) => now - (Number(BigInt(id) >> 22n) + EPOCH);

/** Split matching messages into those that can be bulk-deleted and those too old. */
export function selectPurge(msgs: PurgeMsg[], f: PurgeFilter, now = Date.now()): { recent: string[]; old: string[]; skippedPinned: number } {
  const recent: string[] = [], old: string[] = [];
  let skippedPinned = 0;
  for (const m of msgs) {
    if (f.fromUserId && m.author.id !== f.fromUserId) continue;
    if (f.onlyBots && !m.author.bot) continue;
    if (f.contains && !m.content.toLowerCase().includes(f.contains.toLowerCase())) continue;
    if (m.pinned && !f.includePinned) { skippedPinned++; continue; }
    (ageMs(m.id, now) < BULK_MAX_AGE_MS ? recent : old).push(m.id);
  }
  return { recent, old, skippedPinned };
}

/** Chunks of at most `size` items; a trailing chunk of exactly 1 is returned as-is (the caller deletes it singly). */
export function chunk<T>(a: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size));
  return out;
}
