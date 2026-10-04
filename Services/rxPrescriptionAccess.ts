import { Request, RequestHandler, Response } from "express";
import mongoose from "mongoose";
import { usePharmacy } from "../Controllers/aclController";
import UserAccessLevel from "../Models/UserAccessLevel";
import ProductSeller from "../Models/ProductSeller";
import ProductPackage from "../Models/ProductPackage";
import { IUserFile } from "../Models/UserFile";

const runMiddleware = (middleware: RequestHandler, req: Request, res: Response) =>
  new Promise<void>((resolve) => {
    middleware(req, res, () => resolve());
  });

// Who may open a buyer's paper prescription (2026-10, Lib/rxPrescription.ts)
// besides its UserFile readers (the buyer and the selling pharmacies' owner
// accounts): the super admin / staff allowed to read orders (Finance > order
// detail), and a pharmacy secretary with "readOrders" whose pharmacy sells a
// line of that order carrying this very file. Called by
// notPublicController.getFile only when the user is not a reader.
export const canReadOrderPrescriptionFile = async (
  req: Request,
  res: Response,
  file: IUserFile,
): Promise<boolean> => {
  if (!req.user) return false;
  const orderId = (file.chat as unknown as { _id?: unknown })?._id ?? file.chat;
  if (!orderId) return false;
  const fileId = String(file._id);
  const Order = mongoose.model("Order");
  const order = await Order.findOne({
    _id: orderId,
    $or: [{ "products.prescription.files": file._id }, { "productPackages.prescription.files": file._id }],
  })
    .select("products.item products.prescription.files productPackages.item productPackages.prescription.files")
    .lean<{
      products?: { item: unknown; prescription?: { files?: unknown[] } }[];
      productPackages?: { item: unknown; prescription?: { files?: unknown[] } }[];
    }>();
  if (!order) return false;

  if (req.user.role === "admin") return true;
  if (req.user.role === "notadmin") {
    const access = await UserAccessLevel.findOne({ user: req.user._id }).populate("accessLevel");
    const level = access?.accessLevel as unknown as
      | Record<string, Record<string, boolean> | undefined>
      | undefined;
    if (level?.Order?.readOne) return true;
  }

  const prevName = req.params.name;
  req.params.name = "pharmacy";
  await runMiddleware(usePharmacy("readOrders"), req, res).catch(() => undefined);
  req.params.name = prevName;
  const pharmacy = req.pharmacy;
  if (!pharmacy) return false;
  const carries = (line: { prescription?: { files?: unknown[] } }) =>
    (line.prescription?.files || []).some((f) => String(f) === fileId);
  const productItems = (order.products || []).filter(carries).map((l) => l.item);
  const packageItems = (order.productPackages || []).filter(carries).map((l) => l.item);
  const [sells, packs] = await Promise.all([
    productItems.length
      ? ProductSeller.exists({ _id: { $in: productItems }, seller: pharmacy._id })
      : null,
    packageItems.length
      ? ProductPackage.exists({ _id: { $in: packageItems }, owner: pharmacy._id })
      : null,
  ]);
  return !!(sells || packs);
};
