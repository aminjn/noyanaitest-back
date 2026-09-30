import mongoose from "mongoose";

// Delete integrity for catalog records (2026-09 audit): deleting a city,
// category, tag or test used to leave dead ids behind, which crashed panels
// ("node.test.name") and kept selling orphan offers. The references are
// read from the schemas themselves (every path whose `ref` is the model), so
// a new model that points at a catalog is covered without listing it here.

// `inList` is set for a ref inside an array of subdocuments
// (Order.products[].product): the path to count is "products.product", and
// detaching pulls the whole entry from "products".
type RefPath = {
  model: mongoose.Model<any>;
  path: string;
  isArray: boolean;
  inList?: { list: string; field: string };
};

const collect = (
  schema: mongoose.Schema,
  modelName: string,
  model: mongoose.Model<any>,
  out: RefPath[],
  prefix = "",
  list?: string,
) => {
  schema.eachPath((path, type: any) => {
    const full = prefix + path;
    if (type?.schema && (type.$isMongooseDocumentArray || type.instance === "Array")) {
      collect(type.schema, modelName, model, out, `${full}.`, full);
      return;
    }
    if (type?.schema) {
      collect(type.schema, modelName, model, out, `${full}.`, list);
      return;
    }
    const direct = type?.options?.ref;
    const inArray = type?.caster?.options?.ref ?? type?.options?.type?.[0]?.ref;
    if (direct !== modelName && inArray !== modelName) return;
    out.push({
      model,
      path: full,
      isArray: inArray === modelName,
      ...(list ? { inList: { list, field: full.slice(list.length + 1) } } : {}),
    });
  });
};

const refPathsTo = (modelName: string): RefPath[] => {
  const out: RefPath[] = [];
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    collect(model.schema, modelName, model, out);
  }
  return out;
};

const idFilter = (path: string, id: string) => ({ [path]: new mongoose.Types.ObjectId(id) });

// Refuses the delete while any record points at it; the admin deactivates
// it instead. Returns the reason (Persian, translated by errorMessages).
export const blockIfReferenced =
  (modelName: string) =>
  async (id: string): Promise<string | null> => {
    if (!mongoose.isValidObjectId(id)) return null;
    for (const { model, path } of refPathsTo(modelName)) {
      if (model.modelName === modelName && path === "_id") continue;
      const count = await model.countDocuments(idFilter(path, id));
      if (count)
        return `این مورد در ${count} رکورد دیگر استفاده شده است؛ به‌جای حذف، غیرفعالش کنید`;
    }
    return null;
  };

// For labels such as tags: deleting one removes it from every item that
// carries it (a list loses one entry; a single tag field is cleared).
export const detachReferences =
  (modelName: string) =>
  async (id: string): Promise<string | null> => {
    if (!mongoose.isValidObjectId(id)) return null;
    for (const { model, path, isArray, inList } of refPathsTo(modelName)) {
      if (inList)
        await model.updateMany(idFilter(path, id), {
          $pull: { [inList.list]: { [inList.field]: new mongoose.Types.ObjectId(id) } },
        });
      else if (isArray)
        await model.updateMany(idFilter(path, id), {
          $pull: { [path]: new mongoose.Types.ObjectId(id) },
        });
      else await model.updateMany(idFilter(path, id), { $unset: { [path]: 1 } });
    }
    return null;
  };
