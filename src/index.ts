#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./tool.ts";
import "./tools/server.ts";
import "./tools/channels.ts";
import "./tools/roles.ts";
import "./tools/layout.ts";
import "./tools/messages.ts";

await server.connect(new StdioServerTransport());
