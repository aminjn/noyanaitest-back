// Iranian identifiers as the Moadian system checks them.

export const latinDigits = (s: unknown) =>
  String(s ?? "")
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .trim();

// کد ملی: 10 digits, the last one a mod-11 check
export const validNationalCode = (v: string) => {
  if (!/^\d{10}$/.test(v) || /^(\d)\1{9}$/.test(v)) return false;
  const s = v
    .slice(0, 9)
    .split("")
    .reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const r = s % 11;
  return Number(v[9]) === (r < 2 ? r : 11 - r);
};

// شناسه‌ی ملی اشخاص حقوقی: 11 digits, weighted by the tens digit plus 2
export const validLegalId = (v: string) => {
  if (!/^\d{11}$/.test(v)) return false;
  const k = Number(v[9]) + 2;
  const w = [29, 27, 23, 19, 17, 29, 27, 23, 19, 17];
  const s = v
    .slice(0, 10)
    .split("")
    .reduce((acc, d, i) => acc + (Number(d) + k) * w[i], 0);
  const r = s % 11;
  return Number(v[10]) === (r === 10 ? 0 : r);
};

// what may stand for a taxpayer: a person's national code, a company's
// national id or a 14-digit economic code
export const validTaxpayerCode = (type: "natural" | "legal", v: string) =>
  type === "natural" ? validNationalCode(v) : validLegalId(v) || /^\d{14}$/.test(v);
