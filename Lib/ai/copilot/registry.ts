// The copilot's tool registry (2026-10). Built-in tools register from
// Lib/ai/copilot/tools/*; any other module may add its own:
//
//   import { registerCopilotTool } from "../ai/copilot/registry";
//   registerCopilotTool({ name: "finance.cashForecast", profiles: [...], ... });
//
// The finance AI (Lib/business/financeAi.ts, built separately) is pulled in
// on first use if it exists. It may either call registerCopilotTool itself
// when imported, or export `financeCopilotTools` (an array of CopilotTool,
// or of the looser { name, description, args?, profiles?, acl?, module?,
// kind?, run(ctx, args) } shape - see adaptTool) or a function
// `registerCopilotTools(register)`.
import { NextFunction, Request, RequestHandler, Response } from "express";
import { Card, CopilotTool, ORG_PROFILES, Profile, ToolCtx, txt } from "./types";

const tools = new Map<string, CopilotTool>();

export const registerCopilotTool = (tool: CopilotTool) => {
  if (!tool?.name || typeof tool.run !== "function") return;
  tools.set(tool.name, tool);
};

export const copilotTools = () => [...tools.values()];

// a tool from another module in a looser shape: a string reply becomes an
// insight card, { fields, request } a confirmation card
type LooseTool = Partial<CopilotTool> & {
  name: string;
  description?: string;
  run: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<unknown>;
};
const adaptTool = (t: LooseTool): CopilotTool => ({
  name: t.name,
  profiles: t.profiles && t.profiles.length ? t.profiles : (ORG_PROFILES as Profile[]),
  kind: t.kind || "read",
  description: t.description || t.name,
  args: t.args,
  schema: t.schema,
  acl: t.acl ?? "readFinance",
  module: t.module ?? "accounting",
  adminPermission: t.adminPermission,
  aiFeature: t.aiFeature,
  aiCounted: t.aiCounted,
  run: async (ctx, args): Promise<Card> => {
    const out = (await t.run(ctx, args)) as unknown;
    if (typeof out === "string") return { type: "insight", title: txt("copFinanceTitle", "مالی"), text: out };
    if (out && typeof out === "object" && "type" in (out as Card)) return out as Card;
    const o = (out || {}) as { text?: string; fields?: unknown; request?: unknown; title?: string };
    if (o.request && Array.isArray(o.fields))
      return {
        type: "confirm",
        title: txt("copFinanceTitle", o.title || "مالی"),
        text: o.text,
        fields: o.fields as never,
        request: o.request as never,
      };
    return { type: "insight", title: txt("copFinanceTitle", "مالی"), text: String(o.text || "") };
  },
});

let externalLoaded: Promise<void> | null = null;
// the finance agent's module, when it exists (a variable path keeps the
// compiler from requiring it)
const FINANCE_AI = "../../business/financeAi";
export const loadExternalTools = () => {
  if (!externalLoaded)
    externalLoaded = (async () => {
      try {
        const mod = (await import(FINANCE_AI)) as Record<string, unknown>;
        const list = mod.financeCopilotTools;
        const arr = typeof list === "function" ? await (list as () => unknown)() : list;
        if (Array.isArray(arr)) for (const t of arr) if (t && typeof t === "object" && "name" in t) registerCopilotTool(adaptTool(t as LooseTool));
        if (typeof mod.registerCopilotTools === "function")
          await (mod.registerCopilotTools as (r: (t: LooseTool) => void) => unknown)((t) => registerCopilotTool(adaptTool(t)));
      } catch {
        // not there yet: the built-in finance tools stay
      }
    })();
  return externalLoaded;
};

// ---------------- calling the normal endpoints in-process ----------------

type Over = { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown };

// what the browser would get: documents and dates as JSON
const plain = (v: unknown) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// Runs an existing route handler with the user's own request (login, org,
// ACL grant) and returns its `data`: a read tool shows exactly what the page
// would. A 4xx/5xx answer rejects with that message.
export const invoke = <T = unknown>(handler: RequestHandler, req: Request, over: Over = {}) =>
  new Promise<T>((resolve, reject) => {
    const r = Object.create(req) as Request;
    Object.defineProperty(r, "params", { value: { ...req.params, ...(over.params || {}) }, writable: true });
    Object.defineProperty(r, "query", { value: over.query || {}, writable: true });
    Object.defineProperty(r, "body", { value: over.body || {}, writable: true });
    let code = 200;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const res = {
      statusCode: 200,
      locals: {},
      headersSent: false,
      status(c: number) {
        code = c;

        return this;
      },
      json(d: { data?: unknown; message?: string }) {
        finish(() =>
          code < 400
            ? resolve(plain(d && typeof d === "object" && "data" in d ? d.data : d) as T)
            : reject(Object.assign(new Error(d?.message || "error"), { statusCode: code })),
        );
        return this;
      },
      send(d: unknown) {
        finish(() => resolve(d as T));
        return this;
      },
      end() {
        finish(() => resolve(undefined as T));
        return this;
      },
      setHeader() {
        return this;
      },
      set() {
        return this;
      },
      header() {
        return this;
      },
      cookie() {
        return this;
      },
      clearCookie() {
        return this;
      },
      on() {
        return this;
      },
      once() {
        return this;
      },
    } as unknown as Response;
    try {
      const out = handler(r, res, ((err?: unknown) => finish(() => (err ? reject(err) : resolve(undefined as T)))) as NextFunction);
      Promise.resolve(out).catch((err) => finish(() => reject(err)));
    } catch (err) {
      finish(() => reject(err));
    }
  });

// whether a middleware chain lets the request through (licence gates,
// admin permissions) - nothing is sent to the client
export const passes = async (chain: RequestHandler[], req: Request, res: Response) => {
  for (const mw of chain) {
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const out = mw(req, res, ((err?: unknown) => resolve(!err)) as NextFunction);
        Promise.resolve(out).catch(() => resolve(false));
      } catch {
        resolve(false);
      }
    });
    if (!ok) return false;
  }
  return true;
};
