#!/usr/bin/env node
export {};
if (process.argv[2] === "auth") {
  const { runAuth } = await import("./auth.ts");
  await runAuth(process.argv.slice(3));
} else {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { server } = await import("./tool.ts");
  const { loadTools } = await import("./tools/index.ts");
  await loadTools();
  await server.connect(new StdioServerTransport());
}
