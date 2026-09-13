import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
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
import { notifyNewOrder } from "../Services/orderSmsService";

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
  amount: z.number().int().optional().default(1),
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
      if (cart[model][index].qty === -amount) {
        cart[model].splice(index, 1);
      } else {
        cart[model][index].qty += amount;
      }
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

export const submitCart: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { data, error, success } =
      await submitCartSchema.safeParseAsync(req.body);
    if (!success) return next(new BadInputError(error.message));
    const cart = await Cart.findOne({ owner: req.user._id }).populate(
      cartModels.map((model) => ({
        path: model,
        populate: { path: "item" },
      })),
    );
    const orderItems: Record<
      CartModel,
      { item: unknown; qty: number; price: number }[]
    > = {
      products: [],
      productPackages: [],
      services: [],
      servicePackages: [],
      tests: [],
    };
    let total = 0;
    let itemCount = 0;
    if (cart) {
      for (const model of cartModels) {
        for (const entry of cart[model]) {
          if (!entry.item)
            return next(
              new AppError(
                "یکی از اقلام سبد خرید شما دیگر موجود نیست، لطفا آن را از سبد خرید حذف کنید",
                400,
              ),
            );
          const catalogItem = entry.item as unknown as {
            _id: unknown;
            price?: number;
            discount?: number;
            isActive?: boolean;
          };
          if (
            modelsRequiringActiveItem.includes(model) &&
            !catalogItem.isActive
          )
            return next(
              new AppError(
                "یکی از اقلام سبد خرید شما دیگر در دسترس نیست، لطفا آن را از سبد خرید حذف کنید",
                400,
              ),
            );
          const price = Math.max(
            0,
            (catalogItem.price || 0) - (catalogItem.discount || 0),
          );
          orderItems[model].push({
            item: catalogItem._id,
            qty: entry.qty,
            price,
          });
          total += price * entry.qty;
          itemCount += entry.qty;
        }
      }
    }
    if (itemCount < 1)
      return next(new AppError("سبد خرید شما خالی است", 400));

    const requiresAddress = physicalCartModels.some(
      (model) => orderItems[model].length > 0,
    );
    let addressId: string | undefined;
    if (data.address) {
      if (!isValidObjectId(data.address)) return next(new BadInputError());
      const addressDoc = await UserAddress.findOne({
        _id: data.address,
        user: req.user._id,
      });
      if (!addressDoc)
        return next(new AppError("آدرس انتخاب‌شده معتبر نیست", 400));
      addressId = addressDoc._id.toString();
    } else if (requiresAddress) {
      return next(
        new AppError("لطفا آدرس ارسال سفارش را انتخاب کنید", 400),
      );
    }

    // `data.method` only ever type-checks to "wallet" today (that's the only
    // value orderPaymentMethods allows) - this is written as a branch rather
    // than inlined so a future payment method just adds another branch here
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
    // items. Needs the owner chains populated for phone-number lookups
    // (order above only has bare item refs) - see
    // Services/orderSmsService.ts.
    const orderForSms = await Order.findById(order._id)
      .populate({ path: "user" })
      .populate({
        path: "products",
        populate: { path: "item", populate: { path: "seller", populate: { path: "user" } } },
      })
      .populate({
        path: "productPackages",
        populate: { path: "item", populate: { path: "owner", populate: { path: "user" } } },
      })
      .populate({
        path: "services",
        populate: { path: "item", populate: { path: "owner", populate: { path: "user" } } },
      })
      .populate({
        path: "servicePackages",
        populate: { path: "item", populate: { path: "owner", populate: { path: "user" } } },
      })
      .populate({
        path: "tests",
        populate: {
          path: "item",
          populate: { path: "paraClinic", populate: { path: "user" } },
        },
      });
    if (orderForSms) {
      notifyNewOrder(orderForSms).catch((err) =>
        console.log(
          `[cartController] failed to send new-order SMS for order ${order._id}:`,
          err,
        ),
      );
    }
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
