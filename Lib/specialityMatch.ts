import Speciality from "../Models/Speciality";

// Normalise a Persian speciality title for comparison: Arabic ي/ك -> ی/ک,
// no ZWNJ, no spaces/punctuation, and without the degree words the medical
// council (IRIMC) puts around the field ("متخصص قلب و عروق", "فوق تخصص ...").
const normalize = (value: string) =>
  value
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[‌‏‎]/g, "")
    .replace(/(فوق\s*تخصص|فلوشیپ|متخصص|تخصص|دکترای|دکتری|پزشک|رشته)/g, "")
    .replace(/[\s\-_.،,()]/g, "")
    .trim();

// The active speciality whose name best matches a council title (the longest
// name contained in the title, or containing it), or null if none does.
export const matchSpecialityByTitle = async (title?: string | null) => {
  if (!title) return null;
  const target = normalize(title);
  if (target.length < 2) return null;
  const specialities = await Speciality.find({ active: true }).select("name").lean();
  let best: { _id: unknown; len: number } | null = null;
  for (const sp of specialities) {
    const name = normalize(sp.name || "");
    if (name.length < 2) continue;
    if (target.includes(name) || name.includes(target)) {
      if (!best || name.length > best.len) best = { _id: sp._id, len: name.length };
    }
  }
  return best?._id ?? null;
};
