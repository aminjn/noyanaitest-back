import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import { BadInputError, MiddlewareError, NotFoundError } from "../Lib/AppError";
import Cart from "../Models/Cart";
import z from "zod";
import { isValidObjectId, Model } from "mongoose";
import Product from "../Models/Product";
import ProductSeller from "../Models/ProductSeller";

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
    ]);
    res.status(200).json({ message: "getMyCart", data });
  },
);

export const cartModels = ["products"] as const;

export type CartModel = (typeof cartModels)[number];

const cartModelToModelDict: Record<CartModel, Model<any>> = {
  products: ProductSeller,
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
    console.log(cart);
    const index = cart[model].findIndex(
      (el) => el.item._id.toString() === item._id.toString(),
    );
    if (index < 0) {
      if (amount < 1) return next(new BadInputError());
      console.log({ item: item._id, qty: amount });
      cart[model].push({ item: item._id, qty: amount });
    } else {
      if (cart[model][index].qty === -amount) {
        cart[model].splice(index, 1);
      } else {
        cart[model][index].qty += amount;
      }
    }
    console.log(cart);
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

export const submitCart: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    res.status(200).json({ message: "submitCart" });
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
      (el) => el.item._id.toString() === item._id.toString(),
    );
    if (index < 0) return next(new NotFoundError());
    cart[model].splice(index, 1);
    await cart.save();
    res.status(200).json({ message: "removeCartItem" });
  },
);
