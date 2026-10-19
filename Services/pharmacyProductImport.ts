import mongoose from "mongoose";
import Product from "../Models/Product";
import ProductSeller from "../Models/ProductSeller";
import ProductCategory from "../Models/ProductCategory";
import ProductSpec from "../Models/ProductSpec";
import Pharmacy from "../Models/Pharmacy";
import AppError from "../Lib/AppError";
import { createOldFiles } from "../Lib/oldFiles";
import { toSlateContent } from "../Lib/oldContent";
import slugify from "../Lib/slug";
import { getAppConfig } from "../Lib/appConfig";

// A pharmacy's product list from a partner file (2026-10, the first one
// Saba pharmacy's: «site / groups[] / items[]» with Persian field names).
// Each item becomes the pharmacy's offer of a product: the catalogue product
// is found by name (another pharmacy may sell it already) or created with
// its picture, short and long description and category; the offer carries
// the price and whether it is in stock. Re-running the file updates prices
// and stock, never duplicates. planProductImport() only reads (the admin's
// preview); applyProductImport() writes the same plan.
//
// Benchmark: Snapp Pharmacy and Digikala onboard a pharmacy's catalogue
// from its own export, matched to one shared product page with many
// sellers - the model NoyanAI already has (Product + ProductSeller).

export type ProductRow = {
  name: string;
  image?: string;
  summary?: string;
  description?: string;
  category?: string;
  brand?: string;
  price: number;
  inStock: boolean;
  code?: string;
  source?: string;
};

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const latinDigits = (s: string) =>
  s.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));

// «۲۰٬۰۰۰٬۰۰۰ تومان» -> 20000000 (toman); a rial price is turned to toman
export const parsePrice = (raw: unknown): number => {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
  if (typeof raw !== "string") return 0;
  const text = latinDigits(raw);
  const n = Number(text.replace(/[^\d]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return /ریال/.test(text) ? Math.round(n / 10) : n;
};

// one spelling for matching: Arabic ي/ك, spaces, half-spaces
export const normalizeName = (s: string) =>
  s
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u200c\u200f\u200e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// «تگ ها» glues the category and the brand: «مسواکتریزا - Trisa». The brand
// is the end of the Persian part that the product's name also has
// («... تریزا ...»); what is before it is the category.
export const splitTag = (tag: string | undefined, name: string): { category?: string; brand?: string } => {
  if (!tag) return {};
  const m = tag.match(/^(.*?)\s+-\s+([A-Za-z0-9][\w .&'’+-]*)$/);
  if (!m) return { category: tag.trim() };
  const [, head, latin] = m;
  const words = ` ${normalizeName(name)} `;
  const compactName = normalizeName(name).replace(/\s+/g, "");
  let cut = -1;
  // the longest end of the Persian part that is whole words of the name
  for (let i = 1; i < head.length; i++) {
    const tail = normalizeName(head.slice(i));
    if (tail && words.includes(` ${tail} `)) {
      cut = i;
      break;
    }
  }
  // the name may write it without spaces («پرومکس» for «پرو مکس»)
  if (cut < 0)
    for (let i = 1; i < head.length; i++) {
      const tail = normalizeName(head.slice(i)).replace(/\s+/g, "");
      if (tail.length >= 3 && compactName.includes(tail)) {
        cut = i;
        break;
      }
    }
  if (cut < 0) return { brand: `${head.trim()} - ${latin.trim()}` };
  const category = head.slice(0, cut).trim();
  const brandFa = head.slice(cut).trim();
  return { category: category || undefined, brand: `${brandFa} - ${latin.trim()}` };
};

const rowOf = (item: Record<string, unknown>): ProductRow | null => {
  const name = str(item["نام کالا"]) ?? str(item.name) ?? str(item.title);
  if (!name) return null;
  const tags = str(item["تگ ها"]) ?? str(item.tags);
  const split = splitTag(tags, name);
  const status = str(item["وضعیت"]) ?? str(item.status) ?? "";
  const summary = str(item["توضیحات کوتاه"]) ?? str(item.summary);
  return {
    name: normalizeName(name),
    image: str(item["عکس"]) ?? str(item.image),
    // a short description that only repeats the name is left out
    summary: summary && normalizeName(summary) !== normalizeName(name) ? summary : undefined,
    description: str(item["توضیحات محصول"]) ?? str(item.description),
    category: str(item["دسته بندی"]) ?? str(item.category) ?? split.category,
    brand: str(item["برند"]) ?? str(item.brand) ?? split.brand,
    price: parsePrice(item["قیمت"] ?? item.price),
    inStock: !/ناموجود|out/i.test(status),
    code: str(item["کد کالا"]) ?? str(item.code),
    source: str(item["لینک پروفایل"]) ?? str(item.url),
  };
};

// the partner's shape ({groups:[{items}]}), {items:[]} or a plain array
export const readProductFile = (json: unknown): ProductRow[] => {
  const items: Record<string, unknown>[] = [];
  const take = (list: unknown) => {
    if (Array.isArray(list)) for (const it of list) if (it && typeof it === "object") items.push(it as Record<string, unknown>);
  };
  if (Array.isArray(json)) take(json);
  else if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o.groups)) for (const g of o.groups) take((g as Record<string, unknown>)?.items);
    take(o.items);
    take(o.products);
  }
  return items.map(rowOf).filter((r): r is ProductRow => !!r);
};

type Skip = { name: string; reason: "duplicate" | "noPrice" };
export type ProductImportPlan = {
  pharmacy: { _id: string; name?: string };
  total: number;
  newProducts: number;
  matchedProducts: number;
  newOffers: number;
  updatedOffers: number;
  unchangedOffers: number;
  newCategories: string[];
  skipped: Skip[];
  sample: { name: string; price: number; inStock: boolean; category?: string; matched: boolean }[];
};

// spaces match spaces or half-spaces
const namePattern = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s\u200c]+");
const exactName = (name: string) => new RegExp(`^${namePattern(name)}$`, "i");

const plan = async (pharmacyId: string, rows: ProductRow[]) => {
  if (!mongoose.isValidObjectId(pharmacyId)) throw new AppError("داروخانه را انتخاب کنید", 400);
  const pharmacy = await Pharmacy.findById(pharmacyId).select("name").lean<{ _id: mongoose.Types.ObjectId; name?: string }>();
  if (!pharmacy) throw new AppError("داروخانه پیدا نشد", 404);
  const skipped: Skip[] = [];
  const seen = new Set<string>();
  const items: { row: ProductRow; product: { _id: mongoose.Types.ObjectId; image?: string } | null; offer: { _id: mongoose.Types.ObjectId; price?: number; isActive?: boolean } | null }[] = [];
  const categories = new Map<string, boolean>();
  for (const row of rows) {
    if (seen.has(row.name)) {
      skipped.push({ name: row.name, reason: "duplicate" });
      continue;
    }
    seen.add(row.name);
    if (!row.price) {
      skipped.push({ name: row.name, reason: "noPrice" });
      continue;
    }
    const product = await Product.findOne({ name: exactName(row.name) }).select("_id image").lean<{ _id: mongoose.Types.ObjectId; image?: string }>();
    const offer = product
      ? await ProductSeller.findOne({ product: product._id, seller: pharmacy._id }).select("price isActive").lean<{ _id: mongoose.Types.ObjectId; price?: number; isActive?: boolean }>()
      : null;
    if (row.category && !categories.has(row.category))
      categories.set(row.category, !!(await ProductCategory.exists({ name: exactName(row.category) })));
    items.push({ row, product, offer });
  }
  const result: ProductImportPlan = {
    pharmacy: { _id: String(pharmacy._id), name: pharmacy.name },
    total: rows.length,
    newProducts: items.filter((i) => !i.product).length,
    matchedProducts: items.filter((i) => !!i.product).length,
    newOffers: items.filter((i) => !i.offer).length,
    updatedOffers: items.filter((i) => i.offer && (i.offer.price !== i.row.price || !!i.offer.isActive !== i.row.inStock)).length,
    unchangedOffers: items.filter((i) => i.offer && i.offer.price === i.row.price && !!i.offer.isActive === i.row.inStock).length,
    newCategories: [...categories].filter(([, exists]) => !exists).map(([name]) => name),
    skipped,
    sample: items.slice(0, 8).map((i) => ({ name: i.row.name, price: i.row.price, inStock: i.row.inStock, category: i.row.category, matched: !!i.product })),
  };
  return { result, items, pharmacy };
};

export const planProductImport = async (pharmacyId: string, rows: ProductRow[]) => (await plan(pharmacyId, rows)).result;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const uniqueSlug = async (model: mongoose.Model<any>, name: string) => {
  const root = slugify(name) || `item-${Date.now()}`;
  let slug = root;
  for (let n = 2; await model.exists({ slug }); n++) slug = `${root}-${n}`;
  return slug;
};

export const applyProductImport = async (pharmacyId: string, rows: ProductRow[]) => {
  const { result, items, pharmacy } = await plan(pharmacyId, rows);
  const config = await getAppConfig().catch(() => null);
  const ownOrigins = [process.env.FILE_PATH, config?.siteBaseUrl ? `${config.siteBaseUrl.replace(/\/+$/, "")}/files` : undefined].filter(
    Boolean,
  ) as string[];
  const files = createOldFiles({ download: true, ownOrigins });
  const categoryIds = new Map<string, mongoose.Types.ObjectId>();
  const categoryOf = async (name?: string) => {
    if (!name) return undefined;
    if (categoryIds.has(name)) return categoryIds.get(name);
    const found =
      (await ProductCategory.findOne({ name: exactName(name) }).select("_id").lean<{ _id: mongoose.Types.ObjectId }>()) ||
      (await ProductCategory.create({ name, slug: await uniqueSlug(ProductCategory, name), isActive: true }));
    categoryIds.set(name, found._id);
    return found._id;
  };
  // pictures first, side by side (createOldFiles keeps 6 at a time): one for
  // a new product, or again for one whose earlier download failed (its image
  // is still the partner's absolute URL)
  const isRemote = (v?: string) => !!v && /^https?:\/\//i.test(v);
  const pictures = await Promise.all(
    items.map(({ row, product }) => (row.image && (!product?.image || isRemote(product.image)) ? files.resolve(row.image) : undefined)),
  );
  const images = pictures.filter((p) => p && !isRemote(p)).length;
  for (const [i, { row, product, offer }] of items.entries()) {
    let productId = product?._id;
    const image = pictures[i];
    if (!productId) {
      const created = await Product.create({
        name: row.name,
        slug: await uniqueSlug(Product, row.name),
        image,
        summary: row.summary,
        description: row.description ? await toSlateContent(row.description, files) : undefined,
        category: await categoryOf(row.category),
        price: row.price,
        isActive: true,
      });
      productId = created._id;
      // the brand is a spec row of the product page («برند: تریزا - Trisa»)
      if (row.brand) await ProductSpec.create({ product: productId, refPath: "Product", title: "برند", content: row.brand, isActive: true });
    } else if (image && image !== product?.image) {
      await Product.updateOne({ _id: productId }, { $set: { image } });
    }
    if (offer)
      await ProductSeller.updateOne({ _id: offer._id }, { $set: { price: row.price, isActive: row.inStock } });
    else
      await ProductSeller.create({ product: productId, seller: pharmacy._id, price: row.price, discount: 0, isActive: row.inStock });
  }
  const stats = files.stats;
  return { ...result, images, imageFailures: stats.failed, imageFailureList: stats.failures.slice(0, 10) };
};

// the admin's pharmacy picker: by name, 30 at a time, plus the chosen one
export const findPharmacies = async (q: string, selected?: string) => {
  const text = normalizeName(q || "");
  const list = await Pharmacy.find(text ? { name: new RegExp(namePattern(text), "i") } : {})
    .select("name city")
    .populate({ path: "city", select: "name" })
    .sort({ name: 1 })
    .limit(30)
    .lean();
  if (selected && mongoose.isValidObjectId(selected) && !list.some((p) => String(p._id) === selected)) {
    const one = await Pharmacy.findById(selected).select("name city").populate({ path: "city", select: "name" }).lean();
    if (one) list.unshift(one);
  }
  return list;
};
