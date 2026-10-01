import mongoose, { Model } from "mongoose";
import { IUser, MongoDoc } from "./User";
import { ICheckout } from "./Checkout";
import { IReservation } from "./Reservation";
import { IDoctorProfile } from "./DoctorProfile";
import { IOrder } from "./Order";
import { IBaseDoctorLicense } from "./BaseDoctorLicense";
import { IPharmacy } from "./Pharmacy";
import { IBasePharmacyLicense } from "./BasePharmacyLicense";
import { IClinic } from "./Clinic";
import { IBaseClinicLicense } from "./BaseClinicLicense";
import { IParaClinic } from "./Paraclinic";
import { IBaseParaClinicLicense } from "./BaseParaClinicLicense";
import { IHospital } from "./Hospital";
import { IBaseHospitalLicense } from "./BaseHospitalLicense";
import { IInsurance } from "./Insurance";
import { IBaseInsuranceLicense } from "./BaseInsuranceLicense";
import { IGatewayPayment } from "./GatewayPayment";

// Money an admin moved by hand (2026-10, super admin back office): a manual
// wallet credit/debit (Controllers/adminWalletController.ts), an admin refund
// of a reservation, or taking a doctor's payout back when a no-show is
// overturned (Controllers/adminReservationController.ts).
export const adminTransactionActions = [
  "adjustment",
  "reservationRefund",
  "payoutReversal",
] as const;

export type AdminTransactionAction = (typeof adminTransactionActions)[number];

export interface ITransaction extends MongoDoc {
  user: IUser;
  amount: number;
  checkout?: ICheckout;
  // the reservation/booking this transaction is for - e.g. the patient's
  // payment when it's created, or the doctor's payout once it completes
  reservation?: IReservation;
  // the cart order this transaction is the payment for
  order?: IOrder;
  // the one order line a seller payout / line refund settles (2026-09,
  // Services/orderSettlementService.ts) - keeps each line settled once
  orderItem?: mongoose.Types.ObjectId;
  // set on the doctor's payout transaction so it's traceable to the doctor
  // profile that earned it, since `user` there is the doctor's linked User
  // account, not the DoctorProfile itself
  doctor?: IDoctorProfile;
  // the BaseDoctorLicense tier this transaction paid for, when this
  // transaction is a doctor's license purchase (2026-09) - see
  // doctorController.purchaseLicense
  license?: IBaseDoctorLicense;
  // set on a pharmacy's own transactions so it's traceable to the pharmacy
  // profile involved, same reasoning as `doctor` above (2026-09)
  pharmacy?: IPharmacy;
  // the BasePharmacyLicense tier this transaction paid for, when this
  // transaction is a pharmacy's license purchase (2026-09) - see
  // pharmacyController.purchaseLicense
  pharmacyLicense?: IBasePharmacyLicense;
  // set on a clinic's own transactions so it's traceable to the clinic
  // profile involved, same reasoning as `doctor`/`pharmacy` above (2026-09)
  clinic?: IClinic;
  // the BaseClinicLicense tier this transaction paid for, when this
  // transaction is a clinic's license purchase (2026-09) - see
  // clinicController.purchaseLicense
  clinicLicense?: IBaseClinicLicense;
  // set on a paraClinic's own transactions so it's traceable to the
  // paraClinic profile involved, same reasoning as `doctor`/`pharmacy`/
  // `clinic` above (2026-09)
  paraClinic?: IParaClinic;
  // the BaseParaClinicLicense tier this transaction paid for, when this
  // transaction is a paraClinic's license purchase (2026-09) - see
  // paraClinicController.purchaseLicense
  paraClinicLicense?: IBaseParaClinicLicense;
  // set on a hospital's own transactions so it's traceable to the hospital
  // profile involved, same reasoning as `doctor`/`pharmacy`/`clinic`/
  // `paraClinic` above (2026-09)
  hospital?: IHospital;
  // the BaseHospitalLicense tier this transaction paid for, when this
  // transaction is a hospital's license purchase (2026-09) - see
  // hospitalController.purchaseLicense
  hospitalLicense?: IBaseHospitalLicense;
  // set on an insurance's own transactions so it's traceable to the
  // insurance profile involved, same reasoning as `doctor`/`pharmacy`/
  // `clinic`/`paraClinic`/`hospital` above (2026-09)
  insurance?: IInsurance;
  // the BaseInsuranceLicense tier this transaction paid for, when this
  // transaction is an insurance's license purchase (2026-09) - see
  // insuranceController.purchaseLicense
  insuranceLicense?: IBaseInsuranceLicense;
  // set on the wallet credit produced by a verified online-gateway payment
  // (2026-09, SEP) - see Services/paymentService.ts
  gatewayPayment?: IGatewayPayment;
  // on a provider payout: what the service was worth and the platform's
  // commission taken from it (amount = grossAmount - commission)
  // a wallet -> bank withdrawal this row holds or returns
  withdrawal?: mongoose.Types.ObjectId;
  // set on a row an admin created by hand: what it was, who did it, why
  adminAction?: AdminTransactionAction;
  adminBy?: IUser;
  note?: string;
  // the admin form's one-time key (unique): a resubmitted form - double
  // click, retry after a timeout - can never move the money twice
  adminRequestKey?: string;
  grossAmount?: number;
  commission?: number;
  commissionPercent?: number;
  createdAt: Date;
}

const TransactionSchema = new mongoose.Schema<
  ITransaction,
  Model<ITransaction>
>({
  user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
  amount: { type: Number, required: true },
  checkout: { type: mongoose.Schema.ObjectId, ref: "Checkout" },
  reservation: { type: mongoose.Schema.ObjectId, ref: "Reservation" },
  order: { type: mongoose.Schema.ObjectId, ref: "Order" },
  orderItem: { type: mongoose.Schema.ObjectId },
  doctor: { type: mongoose.Schema.ObjectId, ref: "DoctorProfile" },
  license: { type: mongoose.Schema.ObjectId, ref: "BaseDoctorLicense" },
  pharmacy: { type: mongoose.Schema.ObjectId, ref: "Pharmacy" },
  pharmacyLicense: {
    type: mongoose.Schema.ObjectId,
    ref: "BasePharmacyLicense",
  },
  clinic: { type: mongoose.Schema.ObjectId, ref: "Clinic" },
  clinicLicense: {
    type: mongoose.Schema.ObjectId,
    ref: "BaseClinicLicense",
  },
  paraClinic: { type: mongoose.Schema.ObjectId, ref: "ParaClinic" },
  paraClinicLicense: {
    type: mongoose.Schema.ObjectId,
    ref: "BaseParaClinicLicense",
  },
  hospital: { type: mongoose.Schema.ObjectId, ref: "Hospital" },
  hospitalLicense: {
    type: mongoose.Schema.ObjectId,
    ref: "BaseHospitalLicense",
  },
  insurance: { type: mongoose.Schema.ObjectId, ref: "Insurance" },
  insuranceLicense: {
    type: mongoose.Schema.ObjectId,
    ref: "BaseInsuranceLicense",
  },
  gatewayPayment: { type: mongoose.Schema.ObjectId, ref: "GatewayPayment" },
  withdrawal: { type: mongoose.Schema.ObjectId, ref: "WithdrawalRequest" },
  adminAction: { type: String, enum: adminTransactionActions },
  adminBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  note: { type: String, maxlength: 1000 },
  adminRequestKey: { type: String, unique: true, sparse: true },
  grossAmount: { type: Number, min: 0 },
  commission: { type: Number, min: 0 },
  commissionPercent: { type: Number, min: 0, max: 100 },
  createdAt: { type: Date, default: () => new Date() },
});

const Transaction = mongoose.model("Transaction", TransactionSchema);

export default Transaction;
