/**
 * Every tool module. Literal import paths, so the bundler can follow them.
 * A module missing from this list never registers its tools; a test checks the list against the folder.
 */
export const TOOL_MODULES = {
  server: () => import("./server.ts"),
  channels: () => import("./channels.ts"),
  roles: () => import("./roles.ts"),
  layout: () => import("./layout.ts"),
  messages: () => import("./messages.ts"),
  threads: () => import("./threads.ts"),
  members: () => import("./members.ts"),
  automod: () => import("./automod.ts"),
  community: () => import("./community.ts"),
  stickers: () => import("./stickers.ts"),
  audit: () => import("./audit.ts"),
  templates: () => import("./templates.ts"),
  analytics: () => import("./analytics.ts"),
  stages: () => import("./stages.ts"),
} as const;

export async function loadTools() {
  for (const load of Object.values(TOOL_MODULES)) await load();
}
