import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";

// One row per successful state-changing request made from the admin panel
// (see Services/adminAudit.ts). Field names are stored, never values, so
// secrets saved through settings pages don't end up in the log.
export const adminAuditActions = [
  "create",
  "update",
  "delete",
  "settings",
  "role",
  "logout",
  "sync",
  "migrate",
  "other",
] as const;
export type AdminAuditAction = (typeof adminAuditActions)[number];

export interface IAdminAuditLog extends MongoDoc {
  actor: IUser;
  actorRole: string;
  action: AdminAuditAction;
  // auto-router segment / admin sub-route, e.g. "blog", "appConfig", "users"
  target: string;
  targetId?: string;
  method: string;
  path: string;
  fields: string[];
  // small, non-secret extras (e.g. the new role on a role change)
  details?: Record<string, unknown>;
  status: number;
  ip?: string;
  createdAt: Date;
}

const RETENTION_DAYS = 365;

const AdminAuditLogSchema = new mongoose.Schema<
  IAdminAuditLog,
  Model<IAdminAuditLog>
>({
  actor: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  actorRole: { type: String, required: true },
  action: { type: String, enum: adminAuditActions, required: true },
  target: { type: String, required: true },
  targetId: { type: String },
  method: { type: String, required: true },
  path: { type: String, required: true },
  fields: { type: [String], default: [] },
  details: { type: mongoose.Schema.Types.Mixed },
  status: { type: Number, required: true },
  ip: { type: String },
  createdAt: {
    type: Date,
    default: () => new Date(),
    expires: RETENTION_DAYS * 24 * 60 * 60,
  },
});

AdminAuditLogSchema.index({ createdAt: -1 });
AdminAuditLogSchema.index({ actor: 1, createdAt: -1 });
AdminAuditLogSchema.index({ target: 1, createdAt: -1 });

const AdminAuditLog = mongoose.model("AdminAuditLog", AdminAuditLogSchema);

export default AdminAuditLog;
