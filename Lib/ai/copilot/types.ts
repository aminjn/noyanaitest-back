// «دستیار نویان» (2026-10): one engine, one assistant per profile. The
// types every tool and profile shares. See Lib/ai/copilot/engine.ts for the
// flow and Lib/ai/copilot/registry.ts for how other modules add tools.
import { Request, Response } from "express";
import { z } from "zod";
import { NodeWithAcl } from "../../enums";
import { BizOwner } from "../../business/coa";

// doctor, clinic, hospital, pharmacy, paraClinic, insurance, the patient's
// own dashboard and the super admin. A secretary uses the profile of the
// org she works for, with her own ACL.
export type Profile = NodeWithAcl | "user" | "admin";
export const ORG_PROFILES: NodeWithAcl[] = ["doctor", "clinic", "hospital", "pharmacy", "paraClinic", "insurance"];

// a user-visible text: `k` is the content key the panels translate, `fa`
// the Persian the super admin panel shows through ta(); `p` fills ${1}...
export type Txt = { k: string; fa: string; p?: string[] };
export const txt = (k: string, fa: string, p?: string[]): Txt => (p ? { k, fa, p } : { k, fa });

export type CardField = {
  key: string;
  label: Txt;
  type: "text" | "textarea" | "number" | "date" | "select" | "slot" | "lines";
  value?: unknown;
  options?: { value: string; label: string | Txt }[];
  required?: boolean;
  // "slot": a free session of the doctor (GET /doctor/desk/slots)
  slot?: { sessionTypeField?: string; sessionType?: string; exceptField?: string };
  // "lines": editable rows {item, label, qty, unitCost}
};

export type CardRow = { title: string; sub?: string; badge?: Txt; link?: string };

// What the panel shows for a tool's result. Nothing that changes data runs
// on the server: a "confirm" card carries the normal endpoint (relative to
// /api/v1) that the browser calls with the user's own login after the user
// checks the filled form and confirms; the endpoint's ACL and licence
// checks decide. `{field}` in the path is replaced with that field's value.
export type Card =
  | { type: "navigate"; path: string; title?: Txt }
  | { type: "list"; title: Txt; rows: CardRow[]; text?: string; link?: string; empty?: Txt }
  | { type: "insight"; title: Txt; text: string; link?: string; rows?: CardRow[] }
  | {
      type: "confirm";
      title: Txt;
      text?: string;
      fields: CardField[];
      request: { method: "POST" | "PATCH" | "PUT"; path: string; body?: Record<string, unknown> };
      // where to go after it succeeded (panel-relative path)
      link?: string;
      done?: Txt;
    }
  // the call recording uploader of the panel (Nexxa call analysis)
  | { type: "callAnalyze"; title: Txt }
  | { type: "message"; text: Txt; raw?: string };

export type ToolCtx = {
  req: Request;
  res: Response;
  profile: Profile;
  // the books / CRM owner of an org profile (null for user / admin)
  owner: BizOwner | null;
  // API base of the profile, relative to /api/v1 ("/doctor", "/user", "/admin")
  api: string;
  // the panel's own path in the site ("/doctorpanel", "/dashboard", "/notadmin")
  panel: string;
  can: (action: string) => boolean;
  hasModule: (mod: string) => Promise<boolean>;
};

export type CopilotTool = {
  name: string;
  profiles: Profile[];
  kind: "navigate" | "read" | "write";
  // for the model: what it does, in English
  description: string;
  // for the model: the JSON arguments, e.g. '{"query": string}'
  args?: string;
  schema?: z.ZodType;
  // the ACL action the tool's endpoint needs ("owner" = the account owner)
  acl?: string | "owner" | Partial<Record<Profile, string | "owner">>;
  // the plan module the tool's endpoint needs, per profile when it differs
  module?: string | Partial<Record<Profile, string>>;
  // super admin: the AccessLevel the tool's endpoint needs
  adminPermission?: { model: string; op: "readAll" | "update" };
  // the AI feature this tool runs (Lib/ai/aiFeatures.ts): hidden while the
  // AI policy keeps it from the user, and counted when the tool runs -
  // unless `aiCounted` (the page or function it leads to counts it)
  aiFeature?: string;
  aiCounted?: boolean;
  // false = only the full admin (role "admin")
  run: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<Card>;
};

export type ProfileDef = {
  profile: Profile;
  // the assistant's own instructions (English, for the model)
  prompt: string;
  // pages the assistant may open: key -> path under the panel + a hint
  pages: { key: string; path: string; hint: string }[];
};
