import Order, { IOrder } from "../Models/Order";
import ParaClinicTest from "../Models/ParaClinicTest";
import ParaClinic from "../Models/Paraclinic";
import { settleOrderLine } from "../Services/orderSettlementService";

// A lab line is done once its result reached the patient (2026-10, owner's
// decision). The patient paid upfront - a lab never runs a test before it is
// paid - so the result upload itself completes the line: the same one-way
// pending -> fulfilled move and the same settlement (payout, sampling fee,
// review ask; Services/orderSettlementService.ts settleOrderLine) as the
// lab's manual «انجام شد». "pending" in the filter is the lock: the upload
// and a manual done (or two uploads) can never both move it, and the
// settlement itself skips a payout already made.

type Seller = { _id: unknown; user?: unknown };

const idOf = (v: unknown) => String((v as { _id?: unknown })?._id ?? v);

// the lab that sells a ParaClinicTest (for a caller without req.paraClinic)
const sellerOf = async (itemId: string): Promise<Seller | null> => {
  const item = await ParaClinicTest.findById(itemId).select("paraClinic").lean<{ paraClinic?: unknown }>();
  if (!item?.paraClinic) return null;
  return ParaClinic.findById(idOf(item.paraClinic)).select("user").lean<Seller>();
};

// Moves one pending, result-carrying lab line of a paid order to fulfilled
// and settles it. Returns the updated order, or null when the line is not
// (or no longer) pending with a result - nothing moves then.
export const completeLabLine = async ({
  orderId,
  itemId,
  seller,
}: {
  orderId: unknown;
  itemId: string;
  seller?: Seller | null;
}): Promise<IOrder | null> => {
  const order = await Order.findOneAndUpdate(
    {
      _id: orderId,
      status: "paid",
      tests: { $elemMatch: { item: itemId, status: "pending", "result.uploadedAt": { $exists: true } } },
    },
    { $set: { "tests.$.status": "fulfilled" } },
    { new: true },
  );
  if (!order) return null;
  const lab = seller ?? (await sellerOf(itemId).catch(() => null));
  await settleOrderLine({
    order,
    model: "tests",
    itemId,
    sellerUserId: lab?.user,
    org: lab ? { paraClinic: lab._id as never } : undefined,
  });
  return order;
};

// Lines that got their result before the upload completed them (or whose
// done was never pressed): completed once at start-up, through the same
// path.
export const migrateLabResultCompletion = async () => {
  const orders = await Order.find({
    status: "paid",
    tests: { $elemMatch: { status: "pending", "result.uploadedAt": { $exists: true } } },
  })
    .select("tests")
    .lean();
  let done = 0;
  for (const order of orders) {
    const lines = ((order as { tests?: { item?: unknown; status?: string; result?: { uploadedAt?: Date } }[] }).tests || []).filter(
      (l) => l.status === "pending" && !!l.result?.uploadedAt,
    );
    for (const line of lines) if (await completeLabLine({ orderId: order._id, itemId: idOf(line.item) })) done++;
  }
  if (done) console.log(`[lab] ${done} lab line(s) with a result completed`);
};
