import UserIdentity from "../../Models/UserIdentity";
import MedicalDetail from "../../Models/MedicalDetail";

// What the site already knows about the patient (2026-10, owner request):
// the identity verified through Shahkar (given name, sex, date of birth) and
// what they entered in their health profile (height, weight, blood type).
// The health chat addresses them by name, does not ask their age or sex
// again, and hands it all to the assessment. A complaint about someone else
// («بچه‌ام تب داره», «مادرم») keeps only the name: the age and sex are asked.

export type PatientContext = {
  name?: string;
  age?: number;
  sex?: "female" | "male";
  heightCm?: number;
  weightKg?: number;
  bloodType?: string;
};

const ageOf = (birth?: Date | null) => {
  if (!birth) return undefined;
  const b = new Date(birth);
  if (Number.isNaN(b.getTime())) return undefined;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
  return age >= 0 && age < 130 ? age : undefined;
};

export const patientContext = async (userId: unknown): Promise<PatientContext> => {
  try {
    const [identity, medical] = await Promise.all([
      UserIdentity.findOne({ user: userId }).select("givenName gender dateOfbirth").lean<{ givenName?: string; gender?: string; dateOfbirth?: Date }>(),
      MedicalDetail.findOne({ user: userId }).select("height weight bloodType").lean<{ height?: number; weight?: number; bloodType?: string }>(),
    ]);
    const out: PatientContext = {};
    const name = String(identity?.givenName || "").trim();
    if (name) out.name = name.slice(0, 40);
    const age = ageOf(identity?.dateOfbirth);
    if (age !== undefined) out.age = age;
    if (identity?.gender === "female" || identity?.gender === "male") out.sex = identity.gender;
    if (medical?.height && medical.height > 30 && medical.height < 260) out.heightCm = medical.height;
    if (medical?.weight && medical.weight > 1 && medical.weight < 400) out.weightKg = medical.weight;
    if (medical?.bloodType) out.bloodType = medical.bloodType;
    return out;
  } catch {
    return {};
  }
};

// a complaint about another person: their age and sex are not the patient's
export const aboutSomeoneElse = (text: string) =>
  /(^|\s)(بچه|بچم|کودک|نوزاد|پسرم|دخترم|مادرم|مامانم|پدرم|بابام|همسرم|شوهرم|خانمم|برادرم|خواهرم|مادربزرگ|پدربزرگ|my (son|daughter|child|baby|mother|father|wife|husband))/i.test(text);

// the interview's age group for an age in years
export const ageLabel = (age: number) =>
  age < 0.25 ? "زیر ۳ ماه" : age < 2 ? "۳ ماه تا ۲ سال" : age < 12 ? "۲ تا ۱۲ سال" : age <= 65 ? "۱۲ تا ۶۵ سال" : "بالای ۶۵ سال";

// one line for the model
export const describePatient = (p: PatientContext, self: boolean) => {
  const parts = [
    p.name ? `name: ${p.name}` : "",
    self && p.age !== undefined ? `age: ${p.age}` : "",
    self && p.sex ? `sex: ${p.sex}` : "",
    self && p.heightCm ? `height: ${p.heightCm} cm` : "",
    self && p.weightKg ? `weight: ${p.weightKg} kg` : "",
    self && p.bloodType ? `blood type: ${p.bloodType}` : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  return `What the site knows about the person writing (${self ? "the patient" : "they are asking about someone else, whose age and sex are in the answers"}): ${parts.join(", ")}.${p.name ? ` Address them by their first name, ${p.name}.` : ""}`;
};
