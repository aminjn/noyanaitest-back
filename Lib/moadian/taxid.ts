// The 22-character tax id ("شماره‌ی منحصربه‌فرد مالیاتی") of an invoice, as
// the Moadian API spec builds it: the 6-character memory id (شناسه‌ی یکتای
// حافظه‌ی مالیاتی), the issue day since 1970 in 5 hex digits, the invoice
// serial in 10 hex digits and one Verhoeff check digit over the same three
// parts written in decimal (a letter of the memory id as its char code).

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

export const verhoeff = (digits: string) => {
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i++) c = D[c][P[(i + 1) % 8][Number(rev[i])]];
  return INV[c];
};

export const verhoeffValid = (digits: string) => {
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i++) c = D[c][P[i % 8][Number(rev[i])]];
  return c === 0;
};

const decimalOf = (memoryId: string) =>
  memoryId
    .split("")
    .map((ch) => (/\d/.test(ch) ? ch : String(ch.charCodeAt(0))))
    .join("");

export const MEMORY_ID = /^[A-Z0-9]{6}$/;

export const makeTaxId = (memoryId: string, issuedAt: Date, serial: number) => {
  const id = memoryId.toUpperCase();
  if (!MEMORY_ID.test(id)) throw new Error("bad memory id");
  if (!Number.isInteger(serial) || serial < 1 || serial > 0xffffffffff) throw new Error("bad serial");
  const day = Math.floor(issuedAt.getTime() / 86400000);
  const hex = id + day.toString(16).padStart(5, "0") + serial.toString(16).padStart(10, "0");
  const dec = decimalOf(id) + String(day).padStart(6, "0") + String(serial).padStart(12, "0");
  return (hex + verhoeff(dec)).toUpperCase();
};

// the internal serial (inno) the spec wants next to the tax id: 10 hex digits
export const innoOf = (serial: number) => serial.toString(16).padStart(10, "0").toUpperCase();
