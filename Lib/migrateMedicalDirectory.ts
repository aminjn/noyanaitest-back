import Part from "../Models/Part";
import Disease from "../Models/Disease";
import DiseaseTag from "../Models/DiseaseTag";
import DiseaseCategory from "../Models/DiseaseCategory";
import slugify from "./slug";

// Medical directory (2026-10), once at boot and idempotent:
//
// - body parts saved before Part.isActive existed are on (the directory
//   lists only active parts);
// - disease tags are retired: a coloured chip on the card that filtered
//   nothing and duplicated the category. A disease with a tag and no
//   category gets a category of the same name (created, with the tag's
//   translations and on/off state, if missing), so what the editors typed is
//   kept and becomes a browsable facet (/disease/category/<slug>). The tag
//   itself is left in the database untouched.
export const migrateMedicalDirectory = async () => {
  await Part.updateMany({ isActive: { $exists: false } }, { $set: { isActive: true } });

  const tagIds = await Disease.distinct("tag", {
    tag: { $exists: true, $ne: null },
    $or: [{ category: { $exists: false } }, { category: null }],
  });
  if (!tagIds.length) return;
  const tags = await DiseaseTag.find({ _id: { $in: tagIds } }).lean();
  for (const tag of tags) {
    const name = (tag.name || "").trim();
    if (!name) continue;
    let category = await DiseaseCategory.findOne({ name });
    if (!category) {
      const base = slugify(name);
      const slug =
        base && !(await DiseaseCategory.exists({ slug: base }))
          ? base
          : `${base || "category"}-${String(tag._id).slice(-6)}`;
      category = await DiseaseCategory.create({
        name,
        slug,
        isActive: !!tag.isActive,
        order: tag.order || 0,
        ...((tag as { translations?: unknown }).translations
          ? { translations: (tag as { translations?: unknown }).translations }
          : {}),
      });
    }
    await Disease.updateMany(
      { tag: tag._id, $or: [{ category: { $exists: false } }, { category: null }] },
      { $set: { category: category._id } },
    );
  }
};
