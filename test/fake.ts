import { setRest } from "../src/discord.ts";

export const G = "100000000000000000";
export type Json = Record<string, any>;

/** An in-memory Discord server answering the REST routes the layout and snapshot code uses. */
export class FakeDiscord {
  channels: Json[] = [];
  roles: Json[] = [{ id: G, name: "@everyone", position: 0, permissions: "0", managed: false }];
  extra: Record<string, unknown> = {};
  calls: { method: string; path: string; body?: any }[] = [];
  private next = 900000000000000000n;
  /** Paths that fail with this HTTP status. */
  failing = new Map<string, number>();
  members: Record<string, Json> = {};
  stages: Record<string, Json> = {};
  templates: Json[] = [];
  me = { id: "800000000000000001", username: "bot", bot: true };

  id() { return String(this.next++); }
  mutating() { return this.calls.filter((c) => c.method !== "GET"); }

  private async handle(method: string, path: string, opts?: { body?: any }) {
    this.calls.push({ method, path, body: opts?.body });
    const fail = this.failing.get(path);
    if (fail) throw Object.assign(new Error(`HTTP ${fail}`), { status: fail });
    const body = opts?.body;
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === `/guilds/${G}/channels`) return structuredClone(this.channels);
    if (method === "GET" && path === `/guilds/${G}/roles`) return structuredClone(this.roles);
    if (method === "GET" && path === "/users/@me") return this.me;
    if (method === "GET" && (m = path.match(new RegExp(`^/guilds/${G}/members/(\\d+)$`)))) {
      const mem = this.members[m[1]!];
      if (!mem) throw Object.assign(new Error("Unknown Member"), { status: 404, code: 10007 });
      return structuredClone(mem);
    }
    if ((m = path.match(/^\/stage-instances\/(\d+)$/))) {
      const st = this.stages[m[1]!];
      if (method === "GET" || method === "PATCH" || method === "DELETE") {
        if (!st) throw Object.assign(new Error("Unknown Stage Instance"), { status: 404, code: 10067 });
        if (method === "PATCH") Object.assign(st, body);
        if (method === "DELETE") delete this.stages[m[1]!];
        return structuredClone(st);
      }
    }
    if (method === "POST" && path === "/stage-instances") {
      this.stages[body.channel_id] = { id: this.id(), guild_id: G, ...body };
      return structuredClone(this.stages[body.channel_id]);
    }
    if (path === `/guilds/${G}/templates`) {
      if (method === "GET") return structuredClone(this.templates);
      if (method === "POST") {
        if (this.templates.length) throw Object.assign(new Error("Template already exists"), { status: 400, code: 30031 });
        const t = { code: "tpl" + this.id(), usage_count: 0, updated_at: "2026-01-01T00:00:00Z", ...body };
        this.templates.push(t);
        return structuredClone(t);
      }
    }
    if ((m = path.match(new RegExp(`^/guilds/${G}/templates/(\\w+)$`)))) {
      const i = this.templates.findIndex((t) => t.code === m![1]);
      if (i >= 0 && method === "PUT") return Object.assign(this.templates[i]!, { is_dirty: false });
      if (i >= 0 && method === "PATCH") return Object.assign(this.templates[i]!, body);
      if (i >= 0 && method === "DELETE") return this.templates.splice(i, 1)[0];
    }
    if (method === "GET" && path in this.extra) return structuredClone(this.extra[path]);
    if (method === "GET" && path === `/guilds/${G}`) return { id: G, name: "Test", ...(this.extra[`/guilds/${G}`] as object) };
    if (method === "POST" && path === `/guilds/${G}/channels`) {
      const c = { id: this.id(), position: this.channels.length, parent_id: null, permission_overwrites: [], ...body };
      this.channels.push(c);
      return c;
    }
    if (method === "POST" && path === `/guilds/${G}/roles`) {
      const r = { id: this.id(), position: this.roles.length, managed: false, ...body };
      this.roles.push(r);
      return r;
    }
    if (method === "PATCH" && path === `/guilds/${G}/channels`) {
      for (const p of body) Object.assign(this.channels.find((c) => c.id === p.id)!, { position: p.position });
      return {};
    }
    if ((m = path.match(/^\/channels\/(\d+)$/))) {
      const i = this.channels.findIndex((c) => c.id === m![1]);
      if (method === "GET") return i < 0 ? Promise.reject(Object.assign(new Error("Unknown Channel"), { status: 404, code: 10003 })) : { guild_id: G, ...structuredClone(this.channels[i]!) };
      if (method === "PATCH") { Object.assign(this.channels[i]!, body); return this.channels[i]; }
      if (method === "DELETE") { this.channels.splice(i, 1); return {}; }
    }
    return {};
  }

  install() {
    const f = (method: string) => (route: string, opts?: { body?: any }) => this.handle(method, route.split("?")[0]!, opts);
    setRest({ get: f("GET"), post: f("POST"), patch: f("PATCH"), put: f("PUT"), delete: f("DELETE") });
    return this;
  }
}

export const role = (id: string, name: string, extra: Json = {}) => ({ id, name, position: 1, permissions: "0", managed: false, ...extra });
export const ch = (id: string, name: string, type: number, extra: Json = {}) =>
  ({ id, name, type, position: 0, parent_id: null, permission_overwrites: [], ...extra });
