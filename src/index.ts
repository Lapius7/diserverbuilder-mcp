#!/usr/bin/env node
export {};
if (process.argv[2] === "auth") {
  const { runAuth } = await import("./auth.ts");
  await runAuth(process.argv.slice(3));
} else {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { server } = await import("./tool.ts");
  await import("./tools/server.ts");
  await import("./tools/channels.ts");
  await import("./tools/roles.ts");
  await import("./tools/layout.ts");
  await import("./tools/messages.ts");
  await server.connect(new StdioServerTransport());
}
