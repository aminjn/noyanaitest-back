// «دستیار نویان» engine (2026-10). One flow for every profile:
//
//   1. the profile (doctor ... insurance, user, admin) gives the assistant's
//      own instructions and pages (profiles.ts);
//   2. its tools are filtered for THIS user: the tool's ACL action, plan
//      module and admin permission must pass, exactly as on the tool's
//      endpoint - a secretary only sees what her access allows;
//   3. the clinical model picks at most one tool from that fixed list and
//      fills its JSON arguments (no free-form execution); the arguments are
//      validated with the tool's schema;
//   4. the tool runs: a read calls the normal endpoint handler in-process
//      with the user's own request; a write only returns a confirmation
//      card that the browser sends to the normal endpoint after the user
//      confirms;
//   5. the exchange is kept in a short per-user history (CopilotHistory).
import { Request, Response } from "express";
import moment from "moment-jalaali";
import mongoose from "mongoose";
import * as authController from "../../../Controllers/authController";
import { translateMessage } from "../../i18n/translateMessage";
import { currentLocale } from "../../i18n/requestContext";
import CopilotHistory, { COPILOT_HISTORY_MAX } from "../../../Models/CopilotHistory";
import { replyLanguage } from "../../../Services/panelAiFeatures";
import { clinicalJson, hasPlanModule, isOwner, can as canAct, str } from "../panelAi";
import { ownerOfReq } from "../../../Controllers/businessController";
import { NodeWithAcl } from "../../enums";
import { apiOf, panelPathOf, PROFILES, rulesFor } from "./profiles";
import { copilotTools, loadExternalTools, passes } from "./registry";
import { Card, CopilotTool, ORG_PROFILES, Profile, ToolCtx } from "./types";
import "./tools/common";
import "./tools/doctor";
import "./tools/orgs";
import "./tools/user";
import "./tools/admin";

export const makeCtx = (req: Request, res: Response, profile: Profile): ToolCtx => {
  const moduleCache = new Map<string, Promise<boolean>>();
  const isOrg = (ORG_PROFILES as Profile[]).includes(profile);
  return {
    req,
    res,
    profile,
    owner: isOrg ? ownerOfReq(profile as NodeWithAcl)(req) : null,
    api: apiOf(profile),
    panel: panelPathOf(profile),
    can: (action) => (isOrg ? canAct(req, action) : true),
    hasModule: (mod) => {
      if (!isOrg) return Promise.resolve(true);
      if (!moduleCache.has(mod)) moduleCache.set(mod, hasPlanModule(req, res, mod));
      return moduleCache.get(mod)!;
    },
  };
};

const pick = <T>(v: T | Partial<Record<Profile, T>> | undefined, p: Profile): T | undefined =>
  v && typeof v === "object" ? (v as Partial<Record<Profile, T>>)[p] : (v as T | undefined);

// whether this user may use this tool here (the tool's endpoint checks again)
const allowed = async (ctx: ToolCtx, tool: CopilotTool) => {
  if (!tool.profiles.includes(ctx.profile)) return false;
  const acl = pick<string>(tool.acl as never, ctx.profile);
  if (ctx.profile === "admin") {
    if (acl === "fullAdmin" && ctx.req.user?.role !== "admin") return false;
    if (tool.adminPermission)
      return passes([authController.hasPermission(tool.adminPermission as never)], ctx.req, ctx.res);
    return true;
  }
  if (acl === "owner" && !isOwner(ctx.req)) return false;
  if (acl && acl !== "owner" && !ctx.can(acl)) return false;
  const mod = pick<string>(tool.module as never, ctx.profile);
  if (mod && !(await ctx.hasModule(mod))) return false;
  return true;
};

export const toolsFor = async (ctx: ToolCtx) => {
  await loadExternalTools();
  const all = copilotTools();
  const ok = await Promise.all(all.map((t) => allowed(ctx, t).catch(() => false)));
  return all.filter((_, i) => ok[i]);
};

const today = () => {
  const m = moment().utcOffset(210);
  return `${m.format("YYYY-MM-DD dddd")} (Jalali ${m.format("jYYYY/jMM/jDD")}), time ${m.format("HH:mm")} Tehran`;
};

type HistoryKey = { user: unknown; panel: string; org: unknown };
const historyKey = (ctx: ToolCtx): HistoryKey => {
  const org = ctx.owner?.id || ctx.req.user?._id;
  return { user: ctx.req.user?._id, panel: ctx.profile, org: new mongoose.Types.ObjectId(String(org)) };
};

export const getHistory = async (ctx: ToolCtx) => {
  const h = await CopilotHistory.findOne(historyKey(ctx)).lean();
  return h?.items || [];
};
export const clearHistory = (ctx: ToolCtx) => CopilotHistory.deleteOne(historyKey(ctx));
const pushHistory = (ctx: ToolCtx, items: { role: "user" | "assistant"; text: string; tool?: string }[]) =>
  CopilotHistory.updateOne(
    historyKey(ctx),
    {
      $push: { items: { $each: items.map((i) => ({ ...i, text: i.text.slice(0, 2000), at: new Date() })), $slice: -COPILOT_HISTORY_MAX } },
      $set: { updatedAt: new Date() },
    },
    { upsert: true },
  ).catch(() => undefined);

export type CopilotAnswer = { reply: string; tool?: string; kind?: CopilotTool["kind"]; card?: Card };

export const runCopilot = async (ctx: ToolCtx, text: string, page?: string): Promise<CopilotAnswer> => {
  const def = PROFILES[ctx.profile];
  const tools = await toolsFor(ctx);
  const history = (await getHistory(ctx)).slice(-6);
  const system = `${def.prompt}
Today is ${today()}. The user is on page "${(page || "").slice(0, 120)}". Reply in ${replyLanguage()}, in one or two short sentences.
${rulesFor()}
TOOLS (name: what it does | arguments):
${tools.map((t) => `- ${t.name}: ${t.description}${t.args ? ` | ${t.args}` : ""}`).join("\n")}
PAGES (for the navigate tool, key: what is there):
${def.pages.map((p) => `- ${p.key}: ${p.hint}`).join("\n")}
JSON shape: {"reply": string, "tool": string|null, "args": object}`;
  const convo = history.map((h) => `${h.role === "user" ? "USER" : "ASSISTANT"}: ${h.text}`).join("\n");
  const obj = await clinicalJson(system, `${convo ? `${convo}\n` : ""}USER: ${text.slice(0, 2000)}`, { maxTokens: 700, timeoutMs: 60_000 });
  let reply = str(obj.reply, 800);
  const tool = tools.find((t) => t.name === obj.tool);
  let card: Card | undefined;
  if (tool) {
    const rawArgs = obj.args && typeof obj.args === "object" && !Array.isArray(obj.args) ? (obj.args as Record<string, unknown>) : {};
    const parsed = tool.schema ? tool.schema.safeParse(rawArgs) : { success: true as const, data: rawArgs };
    if (parsed.success) {
      try {
        card = await tool.run(ctx, (parsed.data || {}) as Record<string, unknown>);
      } catch (err) {
        console.error(`copilot tool ${tool.name} failed:`, (err as Error)?.message || err);
        card = {
          type: "message",
          text: { k: "copToolFailed", fa: "این کار انجام نشد" },
          raw: (err as Error)?.message ? translateMessage((err as Error).message, currentLocale()) : undefined,
        };
      }
    }
  }
  if (!reply && !card) reply = "…";
  await pushHistory(ctx, [
    { role: "user", text },
    { role: "assistant", text: reply, ...(tool ? { tool: tool.name } : {}) },
  ]);
  return { reply, ...(tool && card ? { tool: tool.name, kind: tool.kind, card } : {}) };
};

// the tools a profile may use now, for the panel's empty state
export const toolNames = async (ctx: ToolCtx) => (await toolsFor(ctx)).map((t) => ({ name: t.name, kind: t.kind }));
