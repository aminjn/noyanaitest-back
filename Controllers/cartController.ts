import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
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
import UserAddress from "../Models/UserAddress";
import { notifyNewOrderById } from "../Services/orderSmsService";
import { getSepSettings, startSepPayment } from "../Services/paymentService";
import {
  calcTax,
  getDoctorServiceTaxPercent,
  getGlobalTaxSettings,
  getParaClinicTaxPercent,
  getPharmacyTaxPercent,
} from "../Lib/taxSettings";
import { IGlobalTaxSettings } from "../Models/GlobalTaxSettings";

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
          populate: [{ path: "seller" }, { path: "product" }],
        },
      },
      { path: "productPackages", populate: { path: "item" } },
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
    res.status(200).json({ message: "getMyCart", data });
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
    res.status(200).json({ message: "mutateCartItem" });
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
});

// isActive only exists on the "catalog" models (a seller/doctor can
// deactivate their listing) - ParaClinicTest has no such flag, so it's left
// out here
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
      ...(model === "products" ? [{ path: "product" }] : []),
      ...(model === "tests" ? [{ path: "test" }] : []),
    ],
  },
}));

// products/productPackages -> pharmacy tax; services/servicePackages ->
// doctor SERVICE tax (distinct from the doctor VISIT tax applied in
// Controllers/bookingController.ts - see Models/DoctorTaxSettings.ts);
// tests -> paraClinic tax.
const getCartModelTaxPercent = (
  model: CartModel,
  ownerId: string,
  globalTax: IGlobalTaxSettings | null,
): Promise<number> => {
  if (model === "products" || model === "productPackages")
    return getPharmacyTaxPercent(ownerId, globalTax);
  if (model === "services" || model === "servicePackages")
    return getDoctorServiceTaxPercent(ownerId, globalTax);
  return getParaClinicTaxPercent(ownerId, globalTax);
};

type CartOrderItems = Record<
  CartModel,
  { item: unknown; qty: number; price: number }[]
>;

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
          (model === "products" && catalogEntry.product && !catalogEntry.product.isActive) ||
          (model === "tests" && catalogEntry.test && catalogEntry.test.isActive === false)
        )
          return {
            error:
              "یکی از اقلام سبد خرید شما دیگر در دسترس نیست، لطفا آن را از سبد خرید حذف کنید",
          };
        const price = Math.max(
          0,
          (catalogItem.price || 0) - (catalogItem.discount || 0),
        );
        orderItems[model].push({
          item: catalogItem._id,
          qty: entry.qty,
          price,
        });
        subtotal += price * entry.qty;
        const owner = catalogItem[cartModelOwnerField[model]];
        if (owner?._id) {
          const taxPercent = await getCartModelTaxPercent(
            model,
            owner._id as string,
            globalTax,
          );
          tax += calcTax(price * entry.qty, taxPercent);
        }
        itemCount += entry.qty;
      }
    }
  }
  return { orderItems, subtotal, tax, itemCount };
};

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
    const { subtotal, tax } = pricing;
    res.status(200).json({
      message: "getCartSummary",
      data: { subtotal, tax, total: subtotal + tax },
    });
  },
);

export const submitCart: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, error, success } = await submitCartSchema.safeParseAsync(
      req.body,
    );
    if (!success) return next(new BadInputError(error.message));
    const cart = await Cart.findOne({ owner: req.user._id }).populate(
      cartPopulateOptions,
    );
    const pricing = await computeCartPricing(cart);
    if ("error" in pricing) return next(new AppError(pricing.error, 400));
    const { orderItems, subtotal, tax, itemCount } = pricing;
    const total = subtotal + tax;
    if (itemCount < 1) return next(new AppError("سبد خرید شما خالی است", 400));

    const requiresAddress = physicalCartModels.some(
      (model) => orderItems[model].length > 0,
    );
    let addressId: string | undefined;
    if (data.address) {
      if (!isValidObjectId(data.address)) return next(new BadInputError());
      const addressDoc = await UserAddress.findOne({
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

    // SEP online gateway (2026-09): create the order "pending", hand back
    // the bank's payment page URL, and let Services/paymentService.ts mark
    // it paid (and clear the cart / send the new-order SMS) once the
    // payment is verified - or cancelled if it fails or is abandoned. The
    // cart is deliberately left intact until then.
    if (data.method === "sep") {
      if (!(await getSepSettings()).ready)
        return next(new OnlinePaymentNotAvailableError());
      const pendingOrder = await Order.create({
        user: req.user._id,
        ...orderItems,
        subtotal,
        tax,
        total,
        paymentMethod: "sep",
        status: "pending",
        address: addressId,
      });
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
    const order = await Order.create({
      user: req.user._id,
      ...orderItems,
      subtotal,
      tax,
      total,
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
      await order.save();
    } catch (err) {
      // The debit already succeeded but nothing exists to show for it -
      // refund the wallet and remove the unpaid order instead of leaving an
      // orphaned debit with no Transaction/Order to explain it. See
      // AUDIT/FIXES_TODO.md F-03.
      await Wallet.findByIdAndUpdate(wallet._id, { $inc: { balance: total } });
      await Order.deleteOne({ _id: order._id });
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
