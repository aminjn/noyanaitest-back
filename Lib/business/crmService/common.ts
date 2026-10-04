import mongoose from "mongoose";
import Secretary, { nodesWithAclToSecreataryAclPathDict } from "../../../Models/Secretary";
import User from "../../../Models/User";
import UserIdentity from "../../../Models/UserIdentity";
import Notification from "../../../Models/Notification";
import BizContact, { IBizContact } from "../../../Models/BizContact";
import { BizOwner } from "../coa";
import { orgInfo } from "../campaign";
import { own } from "../crm";

// Shared bits of the CRM's engagement and service side (2026-10,
// docs/nexxa-crm-engagement-parity.md): the owner's team (its account and
// its secretaries - who a ticket, a task, an approval or a quiz is given
// to), the panel paths notifications link to, and the in-app notice.

export const oid = (v: unknown) => new mongoose.Types.ObjectId(String((v as { _id?: unknown })?._id ?? v));
export const idRe = /^[0-9a-f]{24}$/;
export const isId = (v: unknown): v is string => typeof v === "string" && idRe.test(v);
export const DAY = 864e5;
export const HOUR = 36e5;
export const ownerOfDoc = (d: { ownerKind: string; ownerId: unknown }) => ({ kind: d.ownerKind, id: String(d.ownerId) }) as BizOwner;
export { own };

// the panel each owner kind works in (links in notifications)
const PANEL: Record<string, string> = {
  doctor: "/doctorpanel",
  clinic: "/clinicpanel",
  hospital: "/hospitalpanel",
  pharmacy: "/pharmacypanel",
  paraClinic: "/paraClinicPanel",
  insurance: "/insurancepanel",
};
export const crmLink = (owner: BizOwner, path: string) => `${PANEL[owner.kind] || ""}/crm/${path}`.replace(/\/+$/, "");

export type TeamMember = { _id: string; name: string; role: "owner" | "secretary" };

// the owner's account and its secretaries (Controllers/crmEngageController
// does the same for follow-ups)
export const team = async (owner: BizOwner): Promise<TeamMember[]> => {
  const info = await orgInfo(owner).catch(() => ({ user: undefined, name: "" }));
  const path = nodesWithAclToSecreataryAclPathDict[owner.kind as keyof typeof nodesWithAclToSecreataryAclPathDict];
  const secs = path
    ? await Secretary.find({ owner: owner.id, ownerPath: path }).select("secretary displayName").lean<{ secretary: unknown; displayName?: string }[]>()
    : [];
  const ids = [info.user, ...secs.map((s) => s.secretary)].filter(Boolean).map(String);
  const [users, idns] = await Promise.all([
    User.find({ _id: { $in: ids } }).select("phone").lean<{ _id: unknown; phone?: string }[]>(),
    UserIdentity.find({ user: { $in: ids } }).select("user givenName lastName").lean<{ user?: unknown; givenName?: string; lastName?: string }[]>(),
  ]);
  const nameOf = (id: string) => {
    const i = idns.find((x) => String(x.user) === id);
    return (i ? `${i.givenName || ""} ${i.lastName || ""}`.trim() : "") || users.find((u) => String(u._id) === id)?.phone || "";
  };
  const out: TeamMember[] = [];
  if (info.user) out.push({ _id: String(info.user), name: info.name || nameOf(String(info.user)), role: "owner" });
  for (const s of secs)
    if (!out.some((m) => m._id === String(s.secretary)))
      out.push({ _id: String(s.secretary), name: s.displayName || nameOf(String(s.secretary)), role: "secretary" });
  return out;
};

export const ownerUser = async (owner: BizOwner) => {
  const info = await orgInfo(owner).catch(() => null);
  return info?.user ? String(info.user) : null;
};

// the given member if they are on the team, else null
export const teamMember = async (owner: BizOwner, id?: unknown) => {
  if (!id) return null;
  const members = await team(owner);
  return members.some((m) => m._id === String(id)) ? String(id) : null;
};

// is this user the panel's owner (not a secretary)?
export const isOwnerUser = async (owner: BizOwner, user?: unknown) => !!user && (await ownerUser(owner)) === String(user);

// An in-app notice (pushed by Models/Notification.ts). Written in Persian
// and translated when read (Lib/i18n/notificationMessages.ts).
export const notify = (user: unknown, title: string, message: string, link?: string) =>
  user
    ? Notification.create({ user, source: "System", title, message: message.slice(0, 500), ...(link ? { link } : {}) }).catch(() => null)
    : Promise.resolve(null);

// the owner's contact of a user account, made when they have none yet
// (a patient who opens a ticket before the contact sync ran)
export const contactOfUser = async (owner: BizOwner, user: unknown): Promise<IBizContact | null> => {
  const c = await BizContact.findOne({ ...own(owner), user: oid(user) }).lean<IBizContact>();
  return c || null;
};

export const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

// "{name}" style variables in a team text (a task title, a note)
export const fill = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? vars[k] : all));
