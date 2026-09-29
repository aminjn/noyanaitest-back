import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { Model, PopulateOptions } from "mongoose";
import AppError, {
  AccessError,
  BadInputError,
  NotFoundError,
} from "../Lib/AppError";
import * as z from "zod";
import { stripMongoOperators } from "../Lib/sanitizeMongoQuery";
import { hasPublicPage, recordSlugChange } from "../Lib/slugChange";

export const getOne: (args: {
  model: Model<any>;
  pop?: PopulateOptions[] | PopulateOptions;
}) => RequestHandler = ({ model, pop }) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const query = model.findById(req.params.nodeId);
    if (pop) query.populate(pop);
    const data = await query;
    if (!data) return next(new NotFoundError());
    res.status(200).json({ message: "getOne", data: { data } });
  });

export const getAll: ({
  model,
}: {
  model: Model<any>;
  population?: PopulateOptions | PopulateOptions[];
  selection?: Record<string, number | boolean | string | object>;
}) => RequestHandler = ({ model, population, selection }) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    // req.query is untrusted input; Express's `qs` parser accepts nested
    // syntax like `?field[$ne]=` which would otherwise land in the Mongo
    // filter as a literal operator. Strip any `$`-prefixed key (at any
    // depth) before using it as a filter - see AUDIT F-09 / Finding 10.3.
    const filter = stripMongoOperators(req.query);
    const query = model.find(filter);
    if (!!selection) query.select(selection);
    if (!!population) query.populate(population);
    const data = await query;
    res.status(200).json({ message: "getAll", data: { data } });
  });

export const create: ({ model }: { model: Model<any> }) => RequestHandler = ({
  model,
}) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const data = await model.create(req.body);
    res.status(200).json({ message: "create", data: { data } });
  });

export const edit: ({ model }: { model: Model<any> }) => RequestHandler = ({
  model,
}) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const body: Record<string, any> = { ...(req.body || {}) };
    // an emptied slug is removed, not stored as "" - two "" values break
    // the unique sparse slug indexes
    if ("slug" in body && (body.slug === "" || body.slug === null)) {
      delete body.slug;
      body.$unset = { ...(body.$unset || {}), slug: 1 };
    }
    const tracksSlug =
      hasPublicPage(model.modelName) && typeof body.slug === "string";
    const before: any = tracksSlug
      ? await model.findById(req.params.nodeId).select("slug").lean()
      : null;
    const updated: any = await model.findByIdAndUpdate(req.params.nodeId, body, {
      new: true,
      // schema rules (required, enum, min/max) apply to admin edits too;
      // the two models whose validators read the whole document keep the
      // old behaviour
      runValidators: !documentValidatorModels.has(model.modelName),
      context: "query",
    });
    if (!updated) return next(new NotFoundError());
    if (before?.slug && updated.slug)
      await recordSlugChange(model.modelName, before.slug, updated.slug);
    res.status(200).json({ message: "edit" });
  });

const documentValidatorModels = new Set(["PageMeta", "Advertisement"]);

export const remove: (args: {
  model: Model<any>;
  guard?: (nodeId: string) => Promise<string | null>;
}) => RequestHandler = ({ model, guard }) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const refusal = guard ? await guard(req.params.nodeId) : null;
    if (refusal) return next(new AppError(refusal, 409));
    await model.findByIdAndDelete(req.params.nodeId);
    res.status(200).json({ message: "remove" });
  });

export const getSingleton: (args: {
  model: Model<any>;
  pop?: PopulateOptions | PopulateOptions[];
}) => RequestHandler = ({ model }) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const data = await model.findOneAndUpdate(
      {},
      {},
      { upsert: true, new: true },
    );
    res.status(200).json({ message: "getSingleton", data: { data } });
  });

export const editSingleton: (args: { model: Model<any> }) => RequestHandler = ({
  model,
}) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    await model.findOneAndUpdate({}, req.body, { upsert: true });
    res.status(200).json({ message: "editSingleton" });
  });

export const mutateCompoundFields: (keys: string[]) => RequestHandler = (
  keys,
) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    for (const key in req.body) {
      if (keys.includes(key)) {
        try {
          req.body[key] = JSON.parse(req.body[key]);
        } catch {}
      }
    }
    next();
  });

// Optional per-entity validation for the generic `autoRouter` map (see
// AUDIT/FIXES_TODO.md F-09 / AUDIT/10_SECURITY_FINDINGS.md Finding 10.3).
// `autoController.create`/`edit`/`editSingleton` pass `req.body` straight
// to Mongoose with no field allowlist ("unfiltered mass-assignment"). These
// two middleware factories let a map entry opt in to a Zod schema that
// validates (and, since it replaces req.body/req.query with the parsed
// result, also narrows/allowlists) the request before it reaches Mongoose.
// A model with no schema configured behaves exactly as before - validation
// is skipped entirely, not defaulted to some implicit shape - since the
// schemas for the ~90 models here are meant to be filled in incrementally.
export const validateBody: (schema: z.ZodTypeAny) => RequestHandler = (
  schema,
) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { data, error, success } = await schema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    req.body = data;
    next();
  });

export const validateQuery: (schema: z.ZodTypeAny) => RequestHandler = (
  schema,
) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { data, error, success } = await schema.safeParseAsync(req.query);
    if (!success) return next(new BadInputError(error.message));
    req.query = data as any;
    next();
  });

// Lets only a full `admin` touch the given fields (e.g. User.role) through
// the generic autoRouter. A `notadmin` with the right AccessLevel can still
// edit the rest of the document, but any update operator (`$set`, `$rename`,
// ...) or a listed field in the body is rejected - otherwise staff could
// promote themselves (or anyone) to admin via POST /auto/user/:id.
// It also stops non-admins from editing documents that belong to an admin.
export const adminOnlyFields: (args: {
  fields: string[];
  model?: Model<any>;
}) => RequestHandler = ({ fields, model }) =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role === "admin") return next();
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (key.startsWith("$") || fields.includes(key.split(".")[0]))
        return next(new AccessError());
    }
    if (model && req.params.nodeId) {
      const target = await model.findById(req.params.nodeId).select("role");
      if (target?.role === "admin") return next(new AccessError());
    }
    next();
  });
