export const isPhone = (val: any): string | undefined => {
  let subject = String(val).trim();
  if (!subject) return undefined;
  if (isNaN(Number(subject))) return undefined;
  if (subject.startsWith("989")) {
    if (subject.length !== 12) return undefined;
  } else if (subject.startsWith("09")) {
    if (subject.length !== 11) return undefined;
    subject = `98${subject.slice(-10)}`;
  } else {
    return undefined;
  }
  return subject;
};

export const isOTP = (val: unknown) =>
  String(val) &&
  Number(val) &&
  !(Number(val) % 1) &&
  Number(val) >= 0 &&
  String(val).length === 6;

type ValidationFunction<T, S = number> = (
  values: unknown[],
  options: {
    required?: boolean;
    min?: S;
    max?: S;
    validate?: (v: T) => boolean;
  }
) => boolean;

export const isValidName: ValidationFunction<string> = (
  values,
  {
    required = undefined,
    min = undefined,
    max = undefined,
    validate = undefined,
  }
) => {
  for (const val of values) {
    if (required && val === undefined) return false;
    if (val === undefined) continue;
    if (typeof val !== "string") return false;
    if (min !== undefined && val.trim().length < min) return false;
    if (max !== undefined && val.trim().length > max) return false;
    if (validate && !validate(val)) return false;
  }
  return true;
};

export const isValidDate: ValidationFunction<Date, Date> = (
  values,
  {
    required = undefined,
    min = undefined,
    max = undefined,
    validate = undefined,
  }
) => {
  for (const val of values) {
    if (required && !val) return false;
    if (val === undefined) continue;
    const then = new Date(String(val));
    if (isNaN(then.getTime())) return false;
    if (min !== undefined && then < min) return false;
    if (max !== undefined && then > max) return false;
    if (validate && !validate(then)) return false;
  }
  return true;
};

export const validateNumber = (
  val: unknown,
  {
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
    integer = true,
  }: { min?: number; max?: number; integer?: boolean } = {}
) =>
  val !== undefined &&
  !isNaN(Number(val)) &&
  Number(val) >= min &&
  Number(val) <= max &&
  (!integer || !(Number(val) % 1));

export const isPositiveInt = (value: unknown) =>
  Number.isInteger(value) && Number(value) > 0;

export const isNonEmptyStrings = (...vals: unknown[]): boolean =>
  vals.every((val) => typeof val === "string" && !!val.trim());

export const isUndefinedOrString = (...vals: unknown[]): boolean =>
  vals.every((val) => val === undefined || typeof val === "string");
