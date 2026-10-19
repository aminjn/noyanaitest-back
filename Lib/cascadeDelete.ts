import mongoose, { Model, Schema, Types } from "mongoose";

// Deleting a record with everything that hangs on it (2026-10, the owner's
// rule: "a doctor's delete clears every table properly, nothing left
// half-broken"). Every model is scanned for fields that point at the
// record's model (ref, refPath, arrays of refs, refs inside sub-documents),
// so a new model is covered without being listed here. For each pointer:
//  - a record that belongs to it (the field is required, or it is the
//    record's owner / doctor / author) is deleted, and what points at that
//    record is handled the same way, a few levels down;
//  - a shared record (a hospital that had the doctor as manager, a user, a
//    speciality's list) only loses the pointer ($unset / $pull).
// planCascade() only reads: the admin sees the counts first; runCascade()
// applies the same plan.

export type CascadeAction = "delete" | "unset" | "pull";

type Site = {
  model: Model<any>;
  path: string;
  // a pointer inside an array of sub-documents: pull that element
  arrayPath?: string;
  subPath?: string;
  isArray: boolean;
  required: boolean;
  // a dynamic ref: the field naming the target model
  refPathField?: string;
};

// a field with one of these names makes the record the target's own
const OWNER_FIELDS = new Set(["doctor", "owner", "author", "doctorProfile", "profile"]);
// records never deleted through someone else: they only lose the pointer
const SHARED_MODELS = new Set([
  "User",
  "DoctorProfile",
  "Clinic",
  "Hospital",
  "Pharmacy",
  "ParaClinic",
  "Insurance",
  "Speciality",
  "ServiceCategory",
  "Disease",
  "Symptom",
  "Drug",
  "CatalogSuggestion",
  "CatalogMerge",
  "AuditLog",
]);
const MAX_DEPTH = 3;

const refOf = (type: any): { ref?: string; refPath?: string } => {
  const o = type?.options || {};
  const caster = type?.caster?.options || {};
  const ref = typeof o.ref === "string" ? o.ref : typeof caster.ref === "string" ? caster.ref : undefined;
  const refPath = typeof o.refPath === "string" ? o.refPath : typeof caster.refPath === "string" ? caster.refPath : undefined;
  return { ref, refPath };
};

const sitesCache = new Map<string, Site[]>();
const sitesFor = (target: string): Site[] => {
  const cached = sitesCache.get(target);
  if (cached) return cached;
  const out: Site[] = [];
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    // discriminators share their base model's collection
    if ((model as any).baseModelName) continue;
    const walk = (schema: Schema, prefix: string, arrayPath?: string) => {
      schema.eachPath((p, type: any) => {
        const full = prefix + p;
        if (type?.schema && (type.$isMongooseDocumentArray || type.$isSingleNested)) {
          walk(type.schema, `${full}.`, type.$isMongooseDocumentArray ? full : arrayPath);
          return;
        }
        const { ref, refPath } = refOf(type);
        const dynamic = !ref && refPath;
        if (ref !== target && !dynamic) return;
        const isArray = !!type?.$isMongooseArray;
        out.push({
          model,
          path: full,
          ...(arrayPath ? { arrayPath, subPath: full.slice(arrayPath.length + 1) } : {}),
          isArray,
          required: !!type?.options?.required,
          ...(dynamic ? { refPathField: prefix + refPath } : {}),
        });
      });
    };
    walk(model.schema, "");
  }
  sitesCache.set(target, out);
  return out;
};

const actionOf = (site: Site): CascadeAction => {
  if (site.arrayPath || site.isArray) return "pull";
  const last = site.path.split(".").pop() || "";
  const own = site.required || OWNER_FIELDS.has(last);
  return own && !SHARED_MODELS.has(site.model.modelName) && !site.path.includes(".") ? "delete" : "unset";
};

const filterOf = (site: Site, ids: Types.ObjectId[], target: string) => ({
  [site.path]: { $in: ids },
  ...(site.refPathField ? { [site.refPathField]: target } : {}),
});

export type CascadeRow = { model: string; path: string; action: CascadeAction; count: number };
export type CascadePlan = {
  rows: CascadeRow[];
  deletes: Map<string, Set<string>>;
  updates: { site: Site; ids: Types.ObjectId[]; target: string; action: CascadeAction; exclude?: Types.ObjectId[] }[];
};

export const planCascade = async (modelName: string, id: string): Promise<CascadePlan> => {
  const plan: CascadePlan = { rows: [], deletes: new Map([[modelName, new Set([id])]]), updates: [] };
  let frontier: { target: string; ids: Types.ObjectId[] }[] = [
    { target: modelName, ids: [new Types.ObjectId(id)] },
  ];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next: { target: string; ids: Types.ObjectId[] }[] = [];
    for (const { target, ids } of frontier) {
      for (const site of sitesFor(target)) {
        const action = actionOf(site);
        const filter = filterOf(site, ids, target);
        if (action === "delete") {
          const found = await site.model.find(filter).select("_id").lean<{ _id: Types.ObjectId }[]>();
          const done = plan.deletes.get(site.model.modelName) || new Set<string>();
          const fresh = found.map((d) => d._id).filter((d) => !done.has(String(d)));
          if (!fresh.length) continue;
          fresh.forEach((d) => done.add(String(d)));
          plan.deletes.set(site.model.modelName, done);
          plan.rows.push({ model: site.model.modelName, path: site.path, action, count: fresh.length });
          next.push({ target: site.model.modelName, ids: fresh });
        } else {
          const count = await site.model.countDocuments(filter);
          if (!count) continue;
          plan.rows.push({ model: site.model.modelName, path: site.path, action, count });
          plan.updates.push({ site, ids, target, action });
        }
      }
    }
    frontier = next;
  }
  // a pointer on a record that is deleted anyway is not touched or counted
  const kept: CascadePlan["updates"] = [];
  const rows = plan.rows.filter((r) => r.action === "delete");
  for (const u of plan.updates) {
    const gone = Array.from(plan.deletes.get(u.site.model.modelName) || []).map((d) => new Types.ObjectId(d));
    const count = await u.site.model.countDocuments({ ...filterOf(u.site, u.ids, u.target), _id: { $nin: gone } });
    if (!count) continue;
    kept.push({ ...u, exclude: gone });
    rows.push({ model: u.site.model.modelName, path: u.site.path, action: u.action, count });
  }
  plan.updates = kept;
  plan.rows = rows;
  return plan;
};

// applies the plan: pointers first, then the owned records, the record last
export const runCascade = async (modelName: string, id: string, plan: CascadePlan) => {
  for (const { site, ids, target, action, exclude } of plan.updates) {
    const filter = { ...filterOf(site, ids, target), ...(exclude?.length ? { _id: { $nin: exclude } } : {}) };
    if (action === "pull") {
      const pull = site.arrayPath
        ? { [site.arrayPath]: { [site.subPath!]: { $in: ids } } }
        : { [site.path]: { $in: ids } };
      await site.model.collection.updateMany(filter, { $pull: pull } as any);
    } else {
      await site.model.collection.updateMany(filter, { $unset: { [site.path]: "" } });
    }
  }
  let deleted = 0;
  for (const [name, set] of plan.deletes) {
    if (name === modelName) continue;
    const ids = Array.from(set).map((s) => new Types.ObjectId(s));
    for (let i = 0; i < ids.length; i += 1000)
      deleted += (await mongoose.model(name).collection.deleteMany({ _id: { $in: ids.slice(i, i + 1000) } })).deletedCount;
  }
  // the record itself, through the model so its own delete hooks run
  await mongoose.model(modelName).findByIdAndDelete(id);
  return { deleted: deleted + 1, updated: plan.updates.length };
};
