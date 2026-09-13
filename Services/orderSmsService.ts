import { IOrder, OrderSmsEvent, OrderSmsVariables } from "../Models/Order";
import { IPharmacy } from "../Models/Pharmacy";
import { IDoctorProfile } from "../Models/DoctorProfile";
import { IParaClinic } from "../Models/Paraclinic";
import { smsPatternNameForEvent } from "../Lib/smsPatternName";
import { sendSMS } from "../Lib/sendSms";

// Direct-to-recipient SMS for a specific order's own buyer and the seller
// org(s) that own at least one of its items - mirrors
// Services/reservationSmsService.ts's shape/conventions exactly. These are
// unconditional transactional sends: every OrderSmsEvent
// (Models/Order.ts) has its own dedicated SmsPatterns field, so a
// typo'd/renamed event is a compile error rather than a silently-wrong
// pattern.
const orderPattern = (event: OrderSmsEvent) => smsPatternNameForEvent(event);

// The buyer's display name for seller-facing patterns' {customerName} -
// mirrors the exact same fallback Controllers/pharmacyController.ts's
// dispatchDeliveryForPharmacy already uses for Snapp's recipient_name
// (order.user has no dedicated "name" field, only auth-oriented
// username/phone).
const customerName = (order: IOrder): string =>
  order.user.username || order.user.phone;

const sendOrderSms = async <E extends OrderSmsEvent>(
  to: string | undefined,
  event: E,
  variables: OrderSmsVariables[E],
  logContext: string,
): Promise<void> => {
  if (!to) {
    console.log(
      `[orderSms] no phone number available for ${logContext} - skipping`,
    );
    return;
  }
  await sendSMS(to, variables, orderPattern(event)).catch((err) =>
    console.log(`[orderSms] failed to send ${logContext}:`, err),
  );
};

// Collects the distinct pharmacy/doctor/paraClinic orgs that own at least
// one item in this order - an order's item arrays can mix items from
// several different sellers of the same or different org types (see
// Models/Order.ts's products/productPackages/services/servicePackages/
// tests). Nothing a Clinic owns can ever appear here (no
// ProductSeller/Service/ParaClinicTest is Clinic-owned today), so there's
// no clinics map - see Models/Order.ts's orderSmsEvents comment.
//
// Requires the order's item.<owner ref> chains to already be populated -
// see notifyNewOrder's caller, Controllers/cartController.ts's submitCart.
const resolveOrderSellers = (
  order: IOrder,
): {
  pharmacies: Map<string, IPharmacy>;
  doctors: Map<string, IDoctorProfile>;
  paraClinics: Map<string, IParaClinic>;
} => {
  const pharmacies = new Map<string, IPharmacy>();
  const doctors = new Map<string, IDoctorProfile>();
  const paraClinics = new Map<string, IParaClinic>();

  for (const p of order.products) {
    const seller = p.item?.seller;
    if (seller?._id) pharmacies.set(seller._id.toString(), seller);
  }
  for (const pp of order.productPackages) {
    const owner = pp.item?.owner;
    if (owner?._id) pharmacies.set(owner._id.toString(), owner);
  }
  for (const s of order.services) {
    const owner = s.item?.owner;
    if (owner?._id) doctors.set(owner._id.toString(), owner);
  }
  for (const sp of order.servicePackages) {
    const owner = sp.item?.owner;
    if (owner?._id) doctors.set(owner._id.toString(), owner);
  }
  for (const t of order.tests) {
    const paraClinic = t.item?.paraClinic;
    if (paraClinic?._id) paraClinics.set(paraClinic._id.toString(), paraClinic);
  }

  return { pharmacies, doctors, paraClinics };
};

// --- New order -------------------------------------------------------
// Fired once, right after an order is successfully submitted (and paid) -
// Controllers/cartController.ts's submitCart. Confirms the order to the
// buyer, and alerts every distinct pharmacy/doctor/paraClinic that owns at
// least one of its items - "based on the nature of the submitted order"
// (2026-09 user request): only the seller types actually present in this
// particular order's items get notified, never all three unconditionally.
export const notifyNewOrder = async (order: IOrder): Promise<void> => {
  const orderId = order._id.toString();

  const tasks: Promise<void>[] = [
    sendOrderSms(
      order.user.phone,
      "newOrderUser",
      { orderId, total: order.total.toString() },
      `newOrderUser (order ${order._id})`,
    ),
  ];

  const { pharmacies, doctors, paraClinics } = resolveOrderSellers(order);
  const customer = customerName(order);

  for (const pharmacy of pharmacies.values()) {
    tasks.push(
      sendOrderSms(
        pharmacy.user?.phone,
        "newOrderPharmacy",
        { orderId, customerName: customer },
        `newOrderPharmacy (order ${order._id}, pharmacy ${pharmacy._id})`,
      ),
    );
  }
  for (const doctor of doctors.values()) {
    tasks.push(
      sendOrderSms(
        doctor.user?.phone,
        "newOrderDoctor",
        { orderId, customerName: customer },
        `newOrderDoctor (order ${order._id}, doctor ${doctor._id})`,
      ),
    );
  }
  for (const paraClinic of paraClinics.values()) {
    tasks.push(
      sendOrderSms(
        paraClinic.user?.phone,
        "newOrderParaClinic",
        { orderId, customerName: customer },
        `newOrderParaClinic (order ${order._id}, paraClinic ${paraClinic._id})`,
      ),
    );
  }

  await Promise.all(tasks);
};
