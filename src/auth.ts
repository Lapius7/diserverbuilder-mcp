import { REST, Routes } from "discord.js";
import { configPath, removeToken, resolveToken, saveToken } from "./config.ts";

const HELP = `Usage: diserverbuilder-mcp auth [status|logout]

  auth          Ask for the bot token (hidden), check it with Discord, and save it
  auth status   Show which token the server would use (the value is never printed)
  auth logout   Delete the saved token

The server reads the token from the DISCORD_BOT_TOKEN environment variable first,
then from ~/.diserverbuilder/config.json (override the folder with DISERVERBUILDER_CONFIG_DIR).`;

/** Read a line from the terminal without echoing it. Falls back to a plain line when stdin is piped. */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (d) => (buf += d));
      stdin.on("end", () => { process.stderr.write("\n"); resolve(buf.split(/\r?\n/)[0] ?? ""); });
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(value));
        if (ch === "\u0003") return done(() => reject(new Error("Cancelled.")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function check(token: string) {
  const rest = new REST({ version: "10" }).setToken(token);
  const me = (await rest.get(Routes.user("@me"))) as { id: string; username: string };
  const guilds = (await rest.get(Routes.userGuilds())) as { id: string; name: string }[];
  return { me, guilds };
}

async function login() {
  const raw = (await readSecret("Bot token (input is hidden): ")).trim().replace(/^Bot\s+/i, "");
  if (!raw) throw new Error("No token entered. Nothing saved.");
  let result;
  try {
    result = await check(raw);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401) throw new Error("Discord rejected this token (401). Copy a fresh one from the Developer Portal (Bot, Reset Token). Nothing saved.");
    throw new Error(`Could not check the token with Discord: ${e instanceof Error ? e.message : e}. Nothing saved.`);
  }
  saveToken(raw);
  console.log(`Saved to ${configPath()} (readable only by you).`);
  console.log(`Bot: ${result.me.username} (${result.me.id})`);
  console.log(result.guilds.length ? `Servers (${result.guilds.length}):\n${result.guilds.map((g) => `  ${g.name} ${g.id}`).join("\n")}` : "The bot has not joined any server yet. Invite it first (see the README).");
  if (process.env.DISCORD_BOT_TOKEN?.trim()) console.log("\nNote: DISCORD_BOT_TOKEN is set in this shell and takes priority over the saved token.");
}

function status() {
  const t = resolveToken();
  if (!t) {
    console.log("No token. Run: npx diserverbuilder-mcp auth");
    process.exitCode = 1;
    return;
  }
  console.log(t.source === "env" ? "Using DISCORD_BOT_TOKEN from the environment." : `Using the token saved in ${configPath()}.`);
}

export async function runAuth(args: string[]) {
  const [cmd] = args;
  try {
    if (!cmd) await login();
    else if (cmd === "status") status();
    else if (cmd === "logout") console.log(removeToken() ? `Deleted ${configPath()}.` : "No saved token.");
    else if (cmd === "-h" || cmd === "--help" || cmd === "help") console.log(HELP);
    else {
      console.error(`Unknown option: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
