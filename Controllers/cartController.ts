import { stampOrderResponseDeadlines } from "../Lib/orderResponse";
import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { resolveMyLicenseModules as resolvePharmacyModules } from "./pharmacyController";
import { resolveMyLicenseModules as resolveDoctorModules } from "./doctorController";
import { resolveMyLicenseModules as resolveParaClinicModules } from "./paraClinicController";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
  OnlinePaymentNotAvailableError,
} from "../Lib/AppError";
import Cart from "../Models/Cart";
import z from "zod";
import { isValidObjectId, Model } from "mongoose";
import Product from "../Models/Product";
import ProductSeller from "../Models/ProductSeller";
import ProductPackage from "../Models/ProductPackage";
import ServicePackage from "../Models/ServicePackage";
import Service from "../Models/Service";
import ParaClinicTest from "../Models/ParaClinicTest";
import Order, { IOrder, orderPaymentMethods } from "../Models/Order";
import Wallet from "../Models/Wallet";
import Transaction from "../Models/Transaction";
import UserAddress, { IUserAddress } from "../Models/UserAddress";
import { planDelivery } from "../Lib/delivery";
import { deliveryAreaBlocks, DeliveryBlock } from "../Lib/delivery";
import Pharmacy from "../Models/Pharmacy";
import { translateMessage } from "../Lib/i18n/translateMessage";
import { currentLocale } from "../Lib/i18n/requestContext";
import City from "../Models/Geo/City";
import { outOfStockProducts } from "../Lib/pharmacyStock";
import { deliveryDiscountFor } from "../Lib/patientPro";
import { notifyNewOrderById } from "../Services/orderSmsService";
// lab sampling appointments (2026-10): kept in their own module, see the
// "sampling" blocks in getCartSummary / submitCart
import {
  bookCartSamplings,
  describeCartSamplings,
  newOrderId,
  planCartSamplings,
  releaseOrderSamplings,
  samplingChoiceSchema,
} from "../Lib/labSampling";
import { getSepSettings, startSepPayment } from "../Services/paymentService";
import {
  calcTax,
  getDoctorServiceTaxPercent,
  getGlobalTaxSettings,
  getParaClinicTaxPercent,
  getPharmacyTaxPercent,
  isVatRegistered,
} from "../Lib/taxSettings";
import { IGlobalTaxSettings } from "../Models/GlobalTaxSettings";
import UserFile from "../Models/UserFile";
import fs from "fs/promises";
import path from "path";
import { sniffExtension } from "./uploadController";
import {
  checkoutPrescriptionSchema,
  CheckoutPrescription,
  IOrderLinePrescription,
  packageNeedsRx,
  productNeedsRx,
  productRxPopulate,
} from "../Lib/rxPrescription";

export const getMyCart: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const data = await Cart.findOneAndUpdate(
      { owner: req.user._id },
      { owner: req.user._id },
      { upsert: true, new: true },
    ).populate([
      {
        path: "products",
        populate: {
          path: "item",
          // the product's drug decides "requires prescription" (2026-10)
          populate: [{ path: "seller" }, { path: "product", populate: productRxPopulate }],
        },
      },
      {
        path: "productPackages",
        populate: {
          path: "item",
          populate: { path: "products", select: "prescriptionRequired drug", populate: productRxPopulate },
        },
      },
      { path: "services", populate: { path: "item" } },
      { path: "servicePackages", populate: { path: "item" } },
      {
        path: "tests",
        populate: {
          path: "item",
          populate: [{ path: "test" }, { path: "paraClinic" }],
        },
      },
    ]);
    // a package needs a prescription when one of its products does; the
    // package's own product list is not sent back (it was only for this)
    const json = data.toJSON() as unknown as Record<string, unknown>;
    const packages = Array.isArray(json.productPackages) ? json.productPackages : [];
    json.productPackages = packages.map((line: any) => {
      const item = line?.item && typeof line.item === "object" ? line.item : null;
      if (!item) return line;
      const requiresPrescription = packageNeedsRx(item);
      const { products: _products, ...rest } = item;
      return { ...line, item: { ...rest, requiresPrescription } };
    });
    const productLines = (Array.isArray(json.products) ? json.products : []).map((line: any) => {
      const product = line?.item?.product;
      if (!product || typeof product !== "object") return line;
      return {
        ...line,
        item: { ...line.item, product: { ...product, requiresPrescription: productNeedsRx(product) } },
      };
    });
    json.products = productLines;
    json.requiresPrescription =
      productLines.some((line: any) => productNeedsRx(line?.item?.product)) ||
      (json.productPackages as any[]).some((line) => !!line?.item?.requiresPrescription);
    res.status(200).json({ message: "getMyCart", data: json });
  },
);

export const getCartSize: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const cart = await Cart.findOne({ owner: req.user._id });
    const size = cart
      ? cartModels.reduce(
          (acc, model) =>
            acc + cart[model].reduce((sum, el) => sum + el.qty, 0),
          0,
        )
      : 0;
    res.status(200).json({ message: "getCartSize", data: size });
  },
);

export const cartModels = [
  "products",
  "productPackages",
  "services",
  "servicePackages",
  "tests",
] as const;

export type CartModel = (typeof cartModels)[number];

const cartModelToModelDict: Record<CartModel, Model<any>> = {
  products: ProductSeller,
  productPackages: ProductPackage,
  services: Service,
  servicePackages: ServicePackage,
  tests: ParaClinicTest,
};

const mutateCartItemSchema = z.strictObject({
  model: z.enum(cartModels),
  item: z.string(),
  // one step of the +/- control (or a small batch) - never a large jump
  amount: z.number().int().min(-100).max(100).optional().default(1),
});

// the delivery-area problem (if any) of one product / package against the
// buyer's newest saved address - what the checkout preselects
const addToCartDeliveryHint = async (
  model: "products" | "productPackages",
  itemId: unknown,
  user: unknown,
): Promise<(DeliveryProblem & { message: string }) | null> => {
  // no saved address yet: only the pharmacy-side rule (Rx needs the
  // pharmacy's own city) can be told
  const address = await UserAddress.findOne({ user, archived: { $ne: true } }).sort({ _id: -1 });
  const doc =
    model === "products"
      ? await ProductSeller.findById(itemId).populate([
          { path: "seller" },
          { path: "product", populate: productRxPopulate },
        ])
      : await ProductPackage.findById(itemId).populate([
          { path: "owner" },
          { path: "products", select: "prescriptionRequired drug", populate: productRxPopulate },
        ]);
  const pharmacy = (doc as unknown as Record<string, unknown> | null)?.[model === "products" ? "seller" : "owner"];
  if (!doc || !pharmacy || typeof pharmacy !== "object") return null;
  const rx =
    model === "products"
      ? productNeedsRx((doc as { product?: unknown }).product)
      : packageNeedsRx(doc);
  const productId = model === "products" ? idOfRef((doc as { product?: unknown }).product) : undefined;
  const [problem] = await deliveryProblems(
    [
      {
        pharmacy: pharmacy as ShipperLine["pharmacy"],
        freeDelivery: false,
        rx,
        products: productId ? [productId] : [],
      },
    ],
    address,
  );
  // the warning the shop shows, in the buyer's language
  return problem ? { ...problem, message: translateMessage(deliveryProblemMessage(problem), currentLocale()) } : null;
};

export const mutateCartItem: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const {
      data: input,
      error,
      success,
    } = await mutateCartItemSchema.spa(req.body);
    if (!success) return next(new BadInputError(error.message));
    const { amount, item: itemId, model } = input;
    if (!isValidObjectId(itemId)) return next(new BadInputError());
    const cart = await Cart.findOneAndUpdate(
      { owner: req.user._id },
      { owner: req.user._id },
      { upsert: true, new: true },
    );
    const item = await cartModelToModelDict[model].findById(itemId);
    if (!item) return next(new NotFoundError());
    const index = cart[model].findIndex(
      (el) => el.item.toString() === item._id.toString(),
    );
    if (index < 0) {
      if (amount < 1) return next(new BadInputError());
      cart[model].push({ item: item._id, qty: amount });
    } else {
      // a line never goes to zero or below: a negative quantity would lower
      // the order total and then refund more than was paid on cancel
      const qty = cart[model][index].qty + amount;
      if (qty < 1) cart[model].splice(index, 1);
      else cart[model][index].qty = Math.min(qty, 100);
    }
    await cart.save();
    // a hint, not a block (2026-10): the item was added, but the buyer's
    // newest address is outside where this pharmacy ships it - checkout
    // (deliveryProblems) refuses it unless another address is chosen
    const delivery =
      index < 0 && (model === "products" || model === "productPackages")
        ? await addToCartDeliveryHint(model, item._id, req.user._id)
        : null;
    res.status(200).json({ message: "mutateCartItem", data: { delivery } });
  },
);

export const clearCart: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    await Cart.findOneAndReplace(
      { owner: req.user._id },
      { owner: req.user._id },
    );
    res.status(200).json({ message: "clearCart" });
  },
);

const submitCartSchema = z.strictObject({
  method: z.enum(orderPaymentMethods),
  address: z.string().optional(),
  // required when the cart holds a prescription-only item (2026-10)
  prescription: checkoutPrescriptionSchema.optional(),
  // sampling: one appointment per lab whose tests need one (Lib/labSampling.ts)
  samplings: z.array(samplingChoiceSchema).max(20).optional(),
});

// a seller/doctor can deactivate these listings; a lab's ParaClinicTest got
// its own switch later (2026-10, absent on old rows = on) and is checked
// with the lab's other rules below
const modelsRequiringActiveItem: CartModel[] = [
  "products",
  "productPackages",
  "services",
  "servicePackages",
];

// physical goods that need to be shipped - a delivery address is required
// on submission only when the cart contains at least one of these
const physicalCartModels: CartModel[] = ["products", "productPackages"];

// Field on each catalog model that names the pharmacy/doctor/paraClinic
// that owns it (2026-09, for tax) - ProductSeller.seller,
// ProductPackage.owner, Service.owner, ServicePackage.owner,
// ParaClinicTest.paraClinic. Populated one level deeper below so the owning
// org's id is available without a second round-trip per line.
const cartModelOwnerField: Record<
  CartModel,
  "seller" | "owner" | "paraClinic"
> = {
  products: "seller",
  productPackages: "owner",
  services: "owner",
  servicePackages: "owner",
  tests: "paraClinic",
};

// Shared by submitCart and getCartSummary - populates each cart line's
// catalog item AND that item's owning org, so both price and tax (2026-09)
// can be resolved from one fetch.
const cartPopulateOptions = cartModels.map((model) => ({
  path: model,
  populate: {
    path: "item",
    populate: [
      { path: cartModelOwnerField[model] },
      // the catalog entry behind an offer: a product / test the admin
      // deactivated is no longer for sale (the public pages already hide it)
      ...(model === "products"
        ? [{ path: "product", populate: productRxPopulate }]
        : []),
      // a package needs a prescription when one of its products does
      ...(model === "productPackages"
        ? [
            {
              path: "products",
              select: "prescriptionRequired drug",
              populate: productRxPopulate,
            },
          ]
        : []),
      ...(model === "tests" ? [{ path: "test" }] : []),
    ],
  },
}));

// products/productPackages -> pharmacy tax; services/servicePackages ->
// doctor SERVICE tax (distinct from the doctor VISIT tax applied in
// Controllers/bookingController.ts - see Models/DoctorTaxSettings.ts);
// tests -> paraClinic tax.
// The seller is the seller of record (2026-10): no tax unless it is
// registered with Moadian (Lib/taxSettings.ts isVatRegistered).
const getCartModelTaxPercent = async (
  model: CartModel,
  ownerId: string,
  globalTax: IGlobalTaxSettings | null,
): Promise<number> => {
  if (model === "products" || model === "productPackages")
    return (await isVatRegistered("pharmacy", ownerId)) ? getPharmacyTaxPercent(ownerId, globalTax) : 0;
  if (model === "services" || model === "servicePackages")
    return (await isVatRegistered("doctor", ownerId)) ? getDoctorServiceTaxPercent(ownerId, globalTax) : 0;
  return (await isVatRegistered("paraClinic", ownerId)) ? getParaClinicTaxPercent(ownerId, globalTax) : 0;
};

// rx / products: for the delivery-area check (Lib/delivery.ts, 2026-10)
type ShipperLine = Parameters<typeof planDelivery>[0][number] & {
  rx?: boolean;
  products?: string[];
};

// the shipments for the chosen address and their fees (Lib/delivery.ts).
// A «پرو» member's order from the threshold up gets the courier fee (or a
// part of it) paid by the platform (Lib/patientPro.ts): each shipment keeps
// its full `fee` (what the pharmacy is credited) and carries proDiscount;
// deliveryFee is what the buyer pays.
const buildDelivery = async (
  shippers: ShipperLine[],
  address: IUserAddress | null | undefined,
  buyer: unknown,
  subtotal: number,
) => {
  const planned = await planDelivery(shippers, address);
  const pro = await deliveryDiscountFor(buyer, subtotal, planned);
  const shipments = pro.shipments;
  const deliveryFee = shipments.reduce((sum, el) => sum + Math.max(0, el.fee - (el.proDiscount || 0)), 0);
  return {
    shipments,
    deliveryFee,
    proDeliveryDiscount: pro.discount,
    proInfo: { member: pro.pro, discount: pro.discount, potential: pro.potential, threshold: pro.threshold },
  };
};

// ---- delivery area (2026-10, Lib/delivery.ts deliveryAreaBlocks) --------
const idOfRef = (value: unknown): string | undefined =>
  value ? String((value as { _id?: unknown })?._id ?? value) : undefined;

type DeliveryAlternative = {
  _id: string;
  name?: string;
  slug?: string;
  // how many of the blocked pharmacy's products it has, out of `of`
  items: number;
  of: number;
};

export type DeliveryProblem = DeliveryBlock & {
  pharmacyName?: string;
  originCityName?: string;
  destinationCityName?: string;
  // pharmacies in the buyer's city selling the same products online
  alternatives: DeliveryAlternative[];
};

const MAX_ALTERNATIVES = 3;

// Other pharmacies in the buyer's city that sell (online, in stock) the
// products a blocked pharmacy can't ship: one query for the city's
// pharmacies and one for their offers, then the plan / stock checks on the
// few best matches only.
const deliveryAlternatives = async (
  products: string[],
  exclude: string,
  city: string,
): Promise<DeliveryAlternative[]> => {
  const wanted = [...new Set(products)].filter((id) => isValidObjectId(id));
  if (!wanted.length) return [];
  const pharmacies = await Pharmacy.find({
    city,
    active: true,
    status: { $ne: "suspended" },
    _id: { $ne: exclude },
  })
    .select("_id name slug")
    .lean();
  if (!pharmacies.length) return [];
  const offers = await ProductSeller.find({
    seller: { $in: pharmacies.map((el) => el._id) },
    product: { $in: wanted },
    isActive: true,
  })
    .select("seller product")
    .lean();
  const bySeller = new Map<string, Set<string>>();
  for (const offer of offers) {
    const key = String(offer.seller);
    if (!bySeller.has(key)) bySeller.set(key, new Set());
    bySeller.get(key)!.add(String(offer.product));
  }
  const ranked = [...bySeller.entries()].sort((a, b) => b[1].size - a[1].size);
  const out: DeliveryAlternative[] = [];
  for (const [sellerId, has] of ranked) {
    if (out.length >= MAX_ALTERNATIVES) break;
    if (!(await sellerTakesOrders("products", sellerId))) continue;
    const out_ = await outOfStockProducts(sellerId, [...has]);
    const available = [...has].filter((id) => !out_.has(id)).length;
    if (!available) continue;
    const doc = pharmacies.find((el) => String(el._id) === sellerId);
    out.push({
      _id: sellerId,
      name: (doc as { name?: string } | undefined)?.name,
      slug: (doc as { slug?: string } | undefined)?.slug,
      items: available,
      of: wanted.length,
    });
  }
  return out.sort((a, b) => b.items - a.items);
};

// the cart's shipments that can't go to the chosen address, with names
// and, for each, pharmacies in the buyer's city that have its products
const deliveryProblems = async (
  shippers: ShipperLine[],
  address: IUserAddress | null | undefined,
): Promise<DeliveryProblem[]> => {
  const blocks = await deliveryAreaBlocks(
    shippers as unknown as Parameters<typeof deliveryAreaBlocks>[0],
    address as unknown as Parameters<typeof deliveryAreaBlocks>[1],
  );
  if (!blocks.length) return [];
  const cityIds = [
    ...new Set(blocks.flatMap((el) => [el.originCity, el.destinationCity]).filter((id): id is string => !!id)),
  ];
  const cities = cityIds.length ? await City.find({ _id: { $in: cityIds } }).select("name") : [];
  const cityName = new Map(cities.map((el) => [String(el._id), (el as { name?: string }).name]));
  return Promise.all(
    blocks.map(async (block) => {
      const line = shippers.find((el) => String(el.pharmacy._id) === block.pharmacy);
      return {
        ...block,
        pharmacyName: (line?.pharmacy as { name?: string } | undefined)?.name,
        originCityName: block.originCity ? cityName.get(block.originCity) : undefined,
        destinationCityName: block.destinationCity ? cityName.get(block.destinationCity) : undefined,
        alternatives: block.destinationCity
          ? await deliveryAlternatives(line?.products || [], block.pharmacy, block.destinationCity)
          : [],
      };
    }),
  );
};

// the checkout refusal for the first problem, in Persian (translated by
// Lib/i18n/errorMessages.ts)
const deliveryProblemMessage = (problem: DeliveryProblem) =>
  problem.reason === "rxNoPharmacyCity"
    ? `«${problem.pharmacyName || ""}» هنوز شهر خود را ثبت نکرده و فعلا داروی نسخه‌ای نمی‌فروشد`
    : problem.reason === "unknownCity"
    ? "شهر آدرس انتخاب‌شده مشخص نیست؛ شهر را در آدرس خود ثبت کنید"
    : problem.reason === "rxOwnCity"
      ? `داروهای نسخه‌ای «${problem.pharmacyName || ""}» فقط به آدرسی در ${problem.originCityName || ""} ارسال می‌شوند`
      : `«${problem.pharmacyName || ""}» به ${problem.destinationCityName || ""} ارسال ندارد`;

type CartOrderItems = Record<
  CartModel,
  {
    item: unknown;
    qty: number;
    price: number;
    tax: number;
    requiresPrescription?: boolean;
    prescription?: IOrderLinePrescription;
  }[]
>;

const ordersModuleCache = new Map<string, boolean>();
const sellerTakesOrders = async (model: CartModel, ownerId: unknown) => {
  const key = `${model}:${String(ownerId)}`;
  const cached = ordersModuleCache.get(key);
  if (cached !== undefined) return cached;
  const modules: readonly string[] =
    model === "tests"
      ? await resolveParaClinicModules(ownerId)
      : model === "services" || model === "servicePackages"
        ? await resolveDoctorModules(ownerId)
        : await resolvePharmacyModules(ownerId);
  const ok = modules.includes("incomingOrders");
  // per request burst only: a plan change shows up within a minute
  ordersModuleCache.set(key, ok);
  setTimeout(() => ordersModuleCache.delete(key), 60_000).unref?.();
  return ok;
};

// Computes each line's snapshotted price (unaffected by tax - 2026-09 user
// decision: item prices never change) into `subtotal`, and separately looks
// up + sums each line's tax (per that line's owning org) into `tax`. Shared
// by submitCart (which then actually charges the buyer) and getCartSummary
// (a read-only preview for the checkout view, no side effects).
const computeCartPricing = async (
  cart: Awaited<ReturnType<typeof Cart.findOne>>,
): Promise<
  | {
      orderItems: CartOrderItems;
      subtotal: number;
      tax: number;
      itemCount: number;
      // pharmacies shipping physical items, for Lib/delivery.ts
      shippers: ShipperLine[];
      // prescription-only lines (2026-10): the owner accounts of the
      // pharmacies selling them may read the buyer's prescription files
      rxCount: number;
      rxReaders: string[];
    }
  | { error: string }
> => {
  const orderItems: CartOrderItems = {
    products: [],
    productPackages: [],
    services: [],
    servicePackages: [],
    tests: [],
  };
  let subtotal = 0;
  let tax = 0;
  let itemCount = 0;
  let rxCount = 0;
  const rxReaders = new Set<string>();
  const shippers = new Map<string, ShipperLine>();
  if (cart) {
    const globalTax = await getGlobalTaxSettings();
    for (const model of cartModels) {
      for (const entry of (cart as any)[model]) {
        if (!entry.item)
          return {
            error:
              "یکی از اقلام سبد خرید شما دیگر موجود نیست، لطفا آن را از سبد خرید حذف کنید",
          };
        // carts saved before the quantity guard may still hold a bad line
        if (!Number.isInteger(entry.qty) || entry.qty < 1)
          return {
            error: "تعداد یکی از اقلام سبد خرید نامعتبر است، لطفا آن را از سبد خرید حذف کنید",
          };
        const catalogItem = entry.item as unknown as {
          _id: unknown;
          price?: number;
          discount?: number;
          isActive?: boolean;
          seller?: { _id: unknown };
          owner?: { _id: unknown };
          paraClinic?: { _id: unknown };
        };
        const ownerDoc = (catalogItem as Record<string, unknown>)[cartModelOwnerField[model]] as
          | { active?: boolean }
          | undefined;
        const catalogEntry = (entry.item as { product?: { isActive?: boolean }; test?: { isActive?: boolean } });
        if (
          (modelsRequiringActiveItem.includes(model) && !catalogItem.isActive) ||
          // the seller itself (pharmacy / doctor / lab) must be active
          (ownerDoc && ownerDoc.active === false) ||
          // or suspended by an admin (Lib/providerStatus.ts)
          (ownerDoc as { status?: string } | undefined)?.status === "suspended" ||
          (model === "products" && catalogEntry.product && !catalogEntry.product.isActive) ||
          (model === "tests" && catalogEntry.test && catalogEntry.test.isActive === false) ||
          // the lab paused this offer (ParaClinicTest.isActive, 2026-10)
          (model === "tests" && catalogItem.isActive === false)
        )
          return {
            error:
              "یکی از اقلام سبد خرید شما دیگر در دسترس نیست، لطفا آن را از سبد خرید حذف کنید",
          };
        // the seller's plan must include taking online orders - otherwise
        // the order would land in a panel page it cannot open
        const ownerId = (ownerDoc as { _id?: unknown } | undefined)?._id;
        if (ownerId && !(await sellerTakesOrders(model, ownerId)))
          return {
            error:
              "یکی از اقلام سبد خرید شما دیگر در دسترس نیست، لطفا آن را از سبد خرید حذف کنید",
          };
        // a product the pharmacy keeps stock of and has none left (no
        // unexpired batch, Lib/pharmacyStock.ts) is not sold online; a
        // package needs every one of its products
        if (ownerId && (model === "products" || model === "productPackages")) {
          const wanted =
            model === "products"
              ? [(entry.item as { product?: unknown }).product]
              : ((entry.item as { products?: unknown[] }).products || []);
          if ((await outOfStockProducts(ownerId, wanted.filter(Boolean))).size)
            return {
              error:
                "یکی از اقلام سبد خرید شما در داروخانه موجود نیست، لطفا آن را از سبد خرید حذف کنید",
            };
        }
        const price = Math.max(
          0,
          (catalogItem.price || 0) - (catalogItem.discount || 0),
        );
        // an item with no price (never set, or discounted to nothing) is
        // never sold for free by mistake
        if (price <= 0)
          return {
            error:
              "یکی از اقلام سبد خرید شما دیگر در دسترس نیست، لطفا آن را از سبد خرید حذف کنید",
          };
        subtotal += price * entry.qty;
        const owner = catalogItem[cartModelOwnerField[model]];
        let lineTax = 0;
        if (owner?._id) {
          const taxPercent = await getCartModelTaxPercent(
            model,
            owner._id as string,
            globalTax,
          );
          lineTax = calcTax(price * entry.qty, taxPercent);
          tax += lineTax;
        }
        const requiresPrescription =
          model === "products"
            ? productNeedsRx((entry.item as { product?: unknown }).product)
            : model === "productPackages"
              ? packageNeedsRx(entry.item)
              : false;
        if (requiresPrescription) {
          rxCount++;
          const ownerUser = (owner as { user?: unknown } | undefined)?.user;
          if (ownerUser)
            rxReaders.add(String((ownerUser as { _id?: unknown })._id ?? ownerUser));
        }
        orderItems[model].push({
          item: catalogItem._id,
          qty: entry.qty,
          price,
          tax: lineTax,
          ...(requiresPrescription ? { requiresPrescription: true } : {}),
        });
        itemCount += entry.qty;
        if (physicalCartModels.includes(model) && owner?._id) {
          const key = String(owner._id);
          // free delivery only when every line this pharmacy ships offers it
          // (a package has no such flag)
          const lineFree =
            model === "products" &&
            !!(catalogItem as { freeDelivery?: boolean }).freeDelivery;
          const prev = shippers.get(key);
          const productId =
            model === "products" ? idOfRef((entry.item as { product?: unknown }).product) : undefined;
          shippers.set(key, {
            pharmacy: owner as ShipperLine["pharmacy"],
            freeDelivery: prev ? prev.freeDelivery && lineFree : lineFree,
            // a prescription-only item ships only within the pharmacy's city
            rx: !!prev?.rx || requiresPrescription,
            products: [...(prev?.products || []), ...(productId ? [productId] : [])],
          });
        }
      }
    }
  }
  return {
    orderItems,
    subtotal,
    tax,
    itemCount,
    shippers: [...shippers.values()],
    rxCount,
    rxReaders: [...rxReaders],
  };
};

// The buyer's prescription, checked against the cart and attached to every
// prescription-only line (2026-10). Paper photos must be the buyer's own
// uploads (uploadPrescriptionFile) not yet used by another order.
const attachPrescription = async (
  orderItems: CartOrderItems,
  rxCount: number,
  userId: unknown,
  input: CheckoutPrescription | undefined,
): Promise<{ error: string } | { files: string[] }> => {
  if (rxCount < 1) return { files: [] };
  if (!input)
    return {
      error:
        "سبد خرید شما داروی نسخه‌ای دارد؛ کد رهگیری نسخه‌ی الکترونیک یا تصویر نسخه را وارد کنید",
    };
  let files: string[] = [];
  if (input.kind === "paper") {
    files = [...new Set(input.files)];
    const owned = await UserFile.countDocuments({
      _id: { $in: files },
      chatPath: "Order",
      readers: userId,
      chat: { $exists: false },
    });
    if (owned !== files.length)
      return { error: "تصویر نسخه معتبر نیست؛ لطفا دوباره بارگذاری کنید" };
  }
  const prescription: IOrderLinePrescription =
    input.kind === "erx"
      ? {
          kind: "erx",
          insurer: input.insurer,
          trackingCode: input.trackingCode,
          nationalCode: input.nationalCode,
          note: input.note,
          status: "pending",
        }
      : {
          kind: "paper",
          files: files as unknown as IOrderLinePrescription["files"],
          note: input.note,
          status: "pending",
        };
  for (const model of ["products", "productPackages"] as const)
    for (const line of orderItems[model])
      if (line.requiresPrescription) line.prescription = prescription;
  return { files };
};

// Once the order exists, its paper prescription belongs to it: readable by
// the buyer and the owners of the pharmacies that sell its Rx lines (their
// staff and the super admin read it through notPublicController).
const linkPrescriptionFiles = async (
  orderId: unknown,
  files: string[],
  readers: string[],
) => {
  if (!files.length) return;
  await UserFile.updateMany(
    { _id: { $in: files }, chat: { $exists: false } },
    {
      $set: { chat: orderId, chatPath: "Order" },
      ...(readers.length ? { $addToSet: { readers: { $each: readers } } } : {}),
    },
  );
};

// POST /cart/prescription (multipart: file) - a photo or PDF of the paper
// prescription, kept private (NotPublic, UserFile "Order") until checkout
// links it to the order. Returns its id for submitCart's prescription.files.
export const uploadPrescriptionFile: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const file = req.file;
    if (!file?.buffer?.length) return next(new BadInputError());
    const declared = (file.originalname.split(".").pop() || "").toLowerCase();
    const ext = sniffExtension(file.buffer, declared);
    if (!ext || !["pdf", "png", "jpg", "jpeg", "webp"].includes(ext))
      return next(new AppError("فقط فایل PDF یا تصویر پذیرفته می‌شود", 400));
    const name = `Prescription-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    await fs.writeFile(path.join(process.cwd(), "NotPublic", name), file.buffer);
    const doc = await UserFile.create({
      chatPath: "Order",
      readers: [req.user._id],
      file: name,
    });
    res.status(200).json({ message: "uploadPrescriptionFile", data: { _id: doc._id } });
  },
);

// Read-only preview of the current user's cart total, tax included - the
// checkout view (Components/Cart/CartCheckoutPopup.tsx) fetches this to show
// subtotal/tax/total before the buyer confirms, since the *TaxSettings
// admin-CRUD routes themselves are admin-only (Routers/autoRouter.ts) and a
// regular buyer can't read a pharmacy/doctor/paraClinic's tax rate directly.
export const getCartSummary: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const cart = await Cart.findOne({ owner: req.user._id }).populate(
      cartPopulateOptions,
    );
    const pricing = await computeCartPricing(cart);
    if ("error" in pricing) return next(new AppError(pricing.error, 400));
    const { subtotal, tax, shippers, rxCount } = pricing;
    // the address the buyer picked decides the courier (same city or not)
    const addressId = typeof req.query.address === "string" ? req.query.address : "";
    const address =
      addressId && isValidObjectId(addressId)
        ? await UserAddress.findOne({
            _id: addressId,
            user: req.user._id,
            archived: { $ne: true },
          })
        : null;
    const { shipments, deliveryFee, proInfo } = await buildDelivery(shippers, address, req.user._id, subtotal);
    // shipments the pharmacy's delivery area refuses (2026-10)
    const undeliverable = await deliveryProblems(shippers, address);
    const pharmacyNames = new Map(
      shippers.map((el) => [
        String(el.pharmacy._id),
        (el.pharmacy as { name?: string }).name,
      ]),
    );
    res.status(200).json({
      message: "getCartSummary",
      data: {
        subtotal,
        tax,
        deliveryFee,
        shipments: shipments.map((el) => ({
          ...el,
          pharmacyName: pharmacyNames.get(String(el.pharmacy)),
        })),
        // true until an address is chosen - the courier isn't known yet
        needsAddress: shippers.length > 0 && !address,
        // shipments that can't go to this address: checkout refuses them
        undeliverable,
        // checkout must collect a prescription (2026-10)
        requiresPrescription: rxCount > 0,
        // sampling: labs whose tests need an appointment (Lib/labSampling.ts);
        // a chosen home visit adds its homeFee to the total
        samplings: await describeCartSamplings(cart),
        // «پرو»: the member's delivery discount, or what Pro would save
        pro: proInfo,
        total: subtotal + tax + deliveryFee,
      },
    });
  },
);

export const submitCart: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, error, success } = await submitCartSchema.safeParseAsync(
      req.body,
    );
    if (!success) {
      if (error.issues.some((issue) => issue.path[0] === "prescription"))
        return next(new AppError("کد رهگیری نسخه یا کد ملی معتبر نیست", 400));
      return next(new BadInputError(error.message));
    }
    const cart = await Cart.findOne({ owner: req.user._id }).populate(
      cartPopulateOptions,
    );
    const pricing = await computeCartPricing(cart);
    if ("error" in pricing) return next(new AppError(pricing.error, 400));
    const { orderItems, subtotal, tax, itemCount, shippers, rxCount, rxReaders } = pricing;
    if (itemCount < 1) return next(new AppError("سبد خرید شما خالی است", 400));
    const rx = await attachPrescription(orderItems, rxCount, req.user._id, data.prescription);
    if ("error" in rx) return next(new AppError(rx.error, 400));

    const requiresAddress = physicalCartModels.some(
      (model) => orderItems[model].length > 0,
    );
    let addressId: string | undefined;
    let addressDoc: IUserAddress | null = null;
    if (data.address) {
      if (!isValidObjectId(data.address)) return next(new BadInputError());
      addressDoc = await UserAddress.findOne({
        _id: data.address,
        user: req.user._id,
        archived: { $ne: true },
      });
      if (!addressDoc)
        return next(new AppError("آدرس انتخاب‌شده معتبر نیست", 400));
      addressId = addressDoc._id.toString();
    } else if (requiresAddress) {
      return next(new AppError("لطفا آدرس ارسال سفارش را انتخاب کنید", 400));
    }
    // the pharmacy's delivery area (2026-10): Rx only within its city, the
    // rest within the area it chose
    const [areaProblem] = await deliveryProblems(shippers, addressDoc);
    if (areaProblem) return next(new AppError(deliveryProblemMessage(areaProblem), 400));
    // shipping: Tapsi's flat fee is charged with the order, Tipax is paid to
    // the courier on delivery
    const { shipments, deliveryFee, proDeliveryDiscount } = await buildDelivery(
      shippers,
      addressDoc,
      req.user._id,
      subtotal,
    );
    // sampling (2026-10, Lib/labSampling.ts): the appointments are checked
    // here; their seats are taken right before the order is created, and
    // given back on every path that ends without a paid order
    const sampling = await planCartSamplings(cart, data.samplings, req.user._id);
    if ("error" in sampling) return next(new AppError(sampling.error, 400));
    const orderId = newOrderId();
    const bookSamplings = () =>
      bookCartSamplings(orderId, req.user!._id, sampling.plans, orderItems.tests as unknown as Record<string, unknown>[]);
    const total = subtotal + tax + deliveryFee + sampling.fee;

    // SEP online gateway (2026-09): create the order "pending", hand back
    // the bank's payment page URL, and let Services/paymentService.ts mark
    // it paid (and clear the cart / send the new-order SMS) once the
    // payment is verified - or cancelled if it fails or is abandoned. The
    // cart is deliberately left intact until then.
    if (data.method === "sep") {
      if (!(await getSepSettings()).ready)
        return next(new OnlinePaymentNotAvailableError());
      // sampling: seats first, before the bank is opened
      const sepBooked = await bookSamplings();
      if ("error" in sepBooked) return next(new AppError(sepBooked.error, 409));
      const pendingOrder = await Order.create({
        _id: orderId,
        samplingFee: sampling.fee,
        user: req.user._id,
        ...orderItems,
        subtotal,
        tax,
        total,
        shipments,
        deliveryFee,
        proDeliveryDiscount,
        paymentMethod: "sep",
        status: "pending",
        address: addressId,
      });
      await linkPrescriptionFiles(pendingOrder._id, rx.files, rxReaders);
      try {
        const { payment, redirectUrl } = await startSepPayment({
          user: req.user,
          amount: total,
          purpose: "order",
          order: pendingOrder,
          returnPath: "/cart",
        });
        return res.status(200).json({
          message: "submitCart",
          data: pendingOrder,
          redirectUrl,
          payment: payment._id,
        });
      } catch (err) {
        await Order.updateOne(
          { _id: pendingOrder._id, status: "pending" },
          { $set: { status: "cancelled" } },
        );
        await releaseOrderSamplings(pendingOrder._id);
        // the bank never opened: the prescription can be used again
        if (rx.files.length)
          await UserFile.updateMany(
            { _id: { $in: rx.files }, chat: pendingOrder._id },
            { $unset: { chat: "" } },
          );
        return next(err);
      }
    }

    if (data.method !== "wallet")
      return next(new AppError("این روش پرداخت در حال حاضر فعال نیست", 400));

    const wallet = await Wallet.findOneAndUpdate(
      { user: req.user._id },
      { user: req.user._id },
      { upsert: true, new: true },
    );
    if (wallet.balance < total)
      return next(new AppError("موجودی کیف پول شما کافی نیست", 400));

    // Create the order before any money moves, in "pending" state - if this
    // throws, the wallet is never touched. See AUDIT/FIXES_TODO.md F-03.
    // sampling: seats first, before the wallet is debited
    const walletBooked = await bookSamplings();
    if ("error" in walletBooked) return next(new AppError(walletBooked.error, 409));
    const order = await Order.create({
      _id: orderId,
      samplingFee: sampling.fee,
      user: req.user._id,
      ...orderItems,
      subtotal,
      tax,
      total,
      shipments,
      deliveryFee,
      proDeliveryDiscount,
      paymentMethod: data.method,
      status: "pending",
      address: addressId,
    });
    // Debit atomically, re-checking the balance in the same update - this
    // closes the race between the read above and this write (two concurrent
    // checkouts could otherwise both pass the check and overdraw the wallet).
    const debitedWallet = await Wallet.findOneAndUpdate(
      { _id: wallet._id, balance: { $gte: total } },
      { $inc: { balance: -total } },
    );
    if (!debitedWallet) {
      await Order.deleteOne({ _id: order._id });
      await releaseOrderSamplings(order._id);
      return next(new AppError("موجودی کیف پول شما کافی نیست", 400));
    }
    try {
      // Record the wallet debit as a transaction pointing back at the order
      // it paid for, then link the order to it - mirrors how
      // submitBookingNew links a Reservation to its Transaction.
      const transaction = await Transaction.create({
        user: req.user._id,
        amount: -total,
        order: order._id,
      });
      order.transaction = transaction._id as unknown as IOrder["transaction"];
      order.status = "paid";
      order.paidAt = new Date();
      // the seller response deadline of each pharmacy / lab line starts now
      await stampOrderResponseDeadlines(order as any);
      await order.save();
      await linkPrescriptionFiles(order._id, rx.files, rxReaders);
    } catch (err) {
      // The debit already succeeded but nothing exists to show for it -
      // refund the wallet and remove the unpaid order instead of leaving an
      // orphaned debit with no Transaction/Order to explain it. See
      // AUDIT/FIXES_TODO.md F-03.
      await Wallet.findByIdAndUpdate(wallet._id, { $inc: { balance: total } });
      await Order.deleteOne({ _id: order._id });
      await releaseOrderSamplings(order._id);
      throw err;
    }
    await Cart.findOneAndReplace(
      { owner: req.user._id },
      { owner: req.user._id },
    );
    res.status(200).json({ message: "submitCart", data: order });
    // Fire-and-forget: confirms the order to the buyer and alerts every
    // distinct pharmacy/doctor/paraClinic that owns at least one of its
    // items - see Services/orderSmsService.ts's notifyNewOrderById (shared
    // with the SEP gateway path in Services/paymentService.ts).
    notifyNewOrderById(order._id.toString());
  },
);

const removeCartItemSchema = z.strictObject({
  model: z.enum(cartModels),
  item: z.string(),
});
export const removeCartItem: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const {
      data: input,
      error,
      success,
    } = await removeCartItemSchema.spa(req.body);
    if (!success) return next(new BadInputError(error.message));
    const { item: itemId, model } = input;
    const cart = await Cart.findOneAndUpdate(
      { owner: req.user._id },
      { owner: req.user._id },
      { upsert: true, new: true },
    );
    const item = await cartModelToModelDict[model].findById(itemId);
    if (!item) return next(new NotFoundError());
    const index = cart[model].findIndex(
      (el) => el.item.toString() === item._id.toString(),
    );
    if (index < 0) return next(new NotFoundError());
    cart[model].splice(index, 1);
    await cart.save();
    res.status(200).json({ message: "removeCartItem" });
  },
);
