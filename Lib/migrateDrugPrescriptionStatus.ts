import Drug, { DrugPrescriptionStatus } from "../Models/Drug";

// Drug.prescriptionStatus was free text (imported from the old site: "OTC",
// "نسخه‌ای", "بدون نیاز به نسخه", "Prescription only", ...). It is now the
// enum otc / rx (Models/Drug.ts). This maps a text value to the enum, or
// undefined when it cannot tell - an unknown value is left for an admin to
// set rather than guessed.
const digitsAndSpaces = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‌‏‎]/g, " ")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s+/g, " ")
    .trim();

export const normalizePrescriptionStatus = (
  value: unknown,
): DrugPrescriptionStatus | undefined => {
  if (typeof value !== "string") return undefined;
  const v = digitsAndSpaces(value);
  if (!v) return undefined;
  if (v === "otc" || v === "rx") return v;
  // "no prescription" phrasings first: they also contain "نسخه"
  if (
    /\botc\b|over[- ]the[- ]counter|non[- ]?prescription|without (a )?prescription|no prescription/.test(v) ||
    /بدون (نیاز به )?نسخه|بدون‌نسخه|غیر ?نسخه|غیرنسخه|بی ?نسخه|نیاز به نسخه ندارد|نیازی به نسخه ندارد|آزاد/.test(v)
  )
    return "otc";
  if (
    /\brx\b|prescription|\bpom\b/.test(v) ||
    /نسخه|تجویز پزشک|با تجویز/.test(v)
  )
    return "rx";
  return undefined;
};

// One-time, idempotent: converts every stored text value. The original text
// is kept on the raw document (prescriptionStatusLegacy, outside the schema)
// so nothing imported is lost.
export const migrateDrugPrescriptionStatus = async () => {
  const rows = await Drug.collection
    .find(
      { prescriptionStatus: { $exists: true, $nin: ["otc", "rx", null] } },
      { projection: { prescriptionStatus: 1 } },
    )
    .toArray();
  let mapped = 0;
  for (const row of rows) {
    const next = normalizePrescriptionStatus(row.prescriptionStatus);
    if (next) mapped++;
    await Drug.collection.updateOne(
      { _id: row._id },
      {
        $set: {
          prescriptionStatusLegacy: row.prescriptionStatus,
          ...(next ? { prescriptionStatus: next } : {}),
        },
        ...(next ? {} : { $unset: { prescriptionStatus: "" } }),
      },
    );
  }
  if (rows.length)
    console.log(
      `[drug] prescriptionStatus: ${mapped}/${rows.length} text values mapped to otc/rx, the rest left unset`,
    );
};
