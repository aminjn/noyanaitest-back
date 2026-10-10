import { startOfTehranDay } from "./Lib/tehranTime";
import { migrateBusinessModules, migrateCrmModule, migrateInventoryModule, migrateMoadianModule, migratePayrollModule } from "./Lib/migrateBusinessModules";
import { startMoadianJob } from "./Lib/moadian/issue";
import { startCampaignJob } from "./Lib/business/campaign";
import { startAutomationJob } from "./Lib/business/crmAutomation";
import { startCrmServiceJob } from "./Lib/business/crmService/job";
import { startCrmSalesJob } from "./Lib/business/crmSales";
import { seedPayrollYears } from "./Lib/business/payroll";
import { startLedgerJob } from "./Lib/business/ledgerPoster";
import { startFinanceJob } from "./Lib/business/financeReports";
import { startPayoutReleaseJob } from "./Lib/payoutHold";
import { startLicenseExpiryJob } from "./Services/licenseExpiryService";
import { migrateCentreLicences, startCentreLicenceJob } from "./Services/centreLicenceService";
import { startPatientProJob } from "./Services/patientProService";
import { startWaitlistJob } from "./Lib/waitlist";
import { mergeLegacyDoctors } from "./Lib/mergeLegacyDoctors";
import { migrateLicensePricing } from "./Lib/migrateLicensePricing";
import { migrateLicensePlans } from "./Lib/migrateLicensePlans";
import { migrateAiPolicy } from "./Lib/migrateAiPolicy";
import { migrateKartabl } from "./Lib/migrateKartabl";
import { migrateFinanceFiles } from "./Lib/migrateFinanceFiles";
import { migrateAdminIntegrity } from "./Lib/migrateAdminIntegrity";
import { migrateMedicalPublished } from "./Lib/medicalContent";
import { startSiteLocalesRefresh } from "./Lib/siteLocales";
import { migrateHospitalPersonelCount } from "./Lib/migrateHospitalPersonelCount";
import { migrateCentreMembership } from "./Lib/migrateCentreMembership";
import { migrateOwnedDoctorsClaimed, republishReadyDrafts } from "./Lib/migrateOwnedDoctorsClaimed";
import { migrateMultiCentreOwners } from "./Lib/migrateMultiCentreOwners";
import { migrateCentreWallets } from "./Lib/migrateCentreWallets";
import { migrateInsurerKind, migrateInsurerLicense } from "./Lib/migrateInsurerKind";
import { migrateInsuranceContracts, startInsuranceContractJob } from "./Lib/insuranceContracts";
import { migrateLabPharmacyIntegrity } from "./Lib/migrateLabPharmacyIntegrity";
import { migrateDrugPrescriptionStatus } from "./Lib/migrateDrugPrescriptionStatus";
import { migratePharmacyShippingScope } from "./Lib/delivery";
import { migrateMedicalDirectory } from "./Lib/migrateMedicalDirectory";
import { migrateVerifiedReviews } from "./Lib/migrateVerifiedReviews";
import { migrateSellerReviews } from "./Lib/migrateSellerReviews";
import { migrateOpeningHours } from "./Lib/migrateOpeningHours";
import { migrateRoundTheClockTags } from "./Lib/migrateRoundTheClockTags";
import { migrateDoctorServices } from "./Lib/migrateDoctorServices";
import { seedPublicHolidays, seedRows } from "./Lib/publicHolidaySeed";
import { refreshHolidayDays } from "./Lib/holidayRefresh";
import { migrateOrderResponseDeadlines } from "./Lib/orderResponse";
import { migrateLabSamplingSettings, startLabSamplingJob } from "./Lib/labSampling";
import { migrateLabSamplingMoves } from "./Lib/labSamplingReschedule";
import {
  runStaleOrderLineSweep,
  startStaleOrderLineJob,
  runOrderResponseSweep,
  startOrderResponseJob,
} from "./Services/orderSettlementService";
import { migrateShipmentDelivery, startShipmentDeliveryJob } from "./Services/shipmentDeliveryService";
import { startSettlementRetryJob } from "./Services/settlementRetryService";
import { dedupeDoctorSlugs } from "./Lib/dedupeDoctorSlugs";
import { IUser } from "./Models/User";
import { createServer } from "http";
import { Server as ioServer } from "socket.io";

declare global {
  namespace Express {
    export interface Request {
      user?: IUser;
      doctor?: IDoctorProfile;
      insurance?: IInsurance;
      clinic?: IClinic;
      pharmacy?: IPharmacy;
      paraClinic?: IParaClinic;
      hospital?: IHospital;
      // Set by aclController.useAcl: "FULL" for the owner, otherwise the
      // mounted secretary's ACL document (or null if they have none).
      aclGrant?: "FULL" | Record<string, unknown> | null;
    }
  }
}

declare module "socket.io" {
  interface Socket {
    user?: IUser | null;
    inCall?: boolean;
  }
}

import app from "./app";
import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import * as env from "./Lib/Env";
import { getAppConfig } from "./Lib/appConfig";
import { bootstrapSuperAdmins } from "./Services/superAdminBootstrap";
import { migrateLegacyTextContent } from "./Services/translationStore";
import DoctorProfile, {
  IDoctorProfile,
  normalizeDoctorSpecialities,
} from "./Models/DoctorProfile";
import { recalcDoctorFeedbackStats } from "./Models/DoctorFeedback";
import { IInsurance } from "./Models/Insurance";
import { IClinic } from "./Models/Clinic";
import { IPharmacy } from "./Models/Pharmacy";
import { IHospital } from "./Models/Hospital";
import { initCallService } from "./Services/Call";
import {
  generateMissingSlugs,
  startSlugGenerationJob,
} from "./Services/slugGenerationService";
import {
  runReservationActivationSweep,
  startReservationActivationJob,
  runReservationReminderSweep,
  startReservationReminderJob,
  runReservationStageReminderSweep,
  startReservationStageReminderJob,
  runReservationFinalizationSweep,
  startReservationFinalizationJob,
  runReservationNoShowNudgeSweep,
  startReservationNoShowNudgeJob,
} from "./Services/reservationActivationService";

let DB = `mongodb://${env.dbHost}:${env.dbPort}/${env.dbName}`;

if (env.DB_USERNAME && env.DB_PASSWORD)
  DB = `mongodb://${env.DB_USERNAME}:${env.DB_PASSWORD}@${env.dbHost}:${env.dbPort}/${env.dbName}?authSource=admin`;

const initiateFolders = async () => {
  const folders = ["Public", "NotPublic", env.CALL_RECORDING_DIR];
  for (let i = 0; i < folders.length; ++i) {
    const pathToFolder = path.join(process.cwd(), folders[i]);
    try {
      const stat = await fs.stat(pathToFolder);
      if (!stat.isDirectory()) throw new Error();
    } catch {
      console.log(`${folders[i]} Folder Not Detected Creating One`);
      try {
        await fs.mkdir(pathToFolder);
      } catch (err) {
        console.log(`There Was An Error Creating ${folders[i]} Folder:`);
        console.log(err);
      }
    }
  }
};

const recalculateAvailabilities = async () => {
  const { bookingHorizonDays } = await getAppConfig();
  const allDoctors = await DoctorProfile.find();
  const now = new Date();
  const lastDay = new Date();
  lastDay.setDate(lastDay.getDate() + bookingHorizonDays);
  for (const doctor of allDoctors) {
    await updateDoctorAvailability({
      doctor,
      startDate: now,
      endDate: lastDay,
    });
  }
};

const cleanUpExpiredDoctorAvailabilities = async () => {
  // days before today in Tehran (Lib/tehranTime.ts), whatever the server's zone
  await DoctorAvailability.deleteMany({ date: { $lt: startOfTehranDay() } });
};

const startDoctorAvailabilityCron = async () => {
  const { recalculateDoctorAvailabilityInterval } = await getAppConfig();
  setInterval(async () => {
    await cleanUpExpiredDoctorAvailabilities();
    await recalculateAvailabilities();
  }, recalculateDoctorAvailabilityInterval);
};

// Background-job intervals (below) are only read from AppConfig once, here
// at boot, to configure each setInterval - changing them from the admin
// settings page takes effect on the next server restart, not live. Values
// read per-request/per-tick elsewhere (SIP creds, Podium keys,
// bookingHorizonDays, reservationReminderMinutesBefore, ...) do update
// immediately, since those call getAppConfig() fresh each time.
// One-time (idempotent) fill of DoctorProfile.recommendCount (2026-09) for
// doctors reviewed before the field existed; new reviews keep it current.
const backfillRecommendCounts = async () => {
  const ids = await DoctorProfile.find({
    feedbackCount: { $gt: 0 },
    recommendCount: { $exists: false },
  }).distinct("_id");
  for (const id of ids) await recalcDoctorFeedbackStats(id).catch(() => {});
};

// One-time (idempotent) speciality invariant for existing doctors: the main
// speciality is part of `specialities` (see Models/DoctorProfile.ts).
const normalizeAllDoctorSpecialities = async () => {
  const rows = await DoctorProfile.find({
    $or: [
      { mainSpeciality: { $exists: true, $ne: null } },
      { "specialities.0": { $exists: true } },
    ],
  })
    .select("mainSpeciality specialities")
    .lean();
  for (const row of rows) {
    const fixed = normalizeDoctorSpecialities(row);
    const current = (row.specialities || []).map(String);
    if (
      row.mainSpeciality &&
      current.length === fixed.specialities.length &&
      current.every((el, i) => el === fixed.specialities[i])
    )
      continue;
    await DoctorProfile.updateOne(
      { _id: row._id },
      {
        $set: {
          specialities: fixed.specialities,
          ...(row.mainSpeciality ? {} : { mainSpeciality: fixed.mainSpeciality }),
        },
      },
    );
  }
};

const init = async () => {
  await initiateFolders();
  await bootstrapSuperAdmins();
  await migrateLegacyTextContent();
  await cleanUpExpiredDoctorAvailabilities();
  await recalculateAvailabilities();
  await startDoctorAvailabilityCron();
  await generateMissingSlugs();
  await migrateMedicalPublished().catch((err) =>
    console.log("[medicalContent] publish migration failed:", err),
  );
  await backfillRecommendCounts();
  await migrateVerifiedReviews().catch((err) =>
    console.log("[reviews] verified score migration failed:", err),
  );
  await migrateSellerReviews().catch((err) =>
    console.log("[reviews] seller reviews migration failed:", err),
  );
  await normalizeAllDoctorSpecialities();
  await migrateHospitalPersonelCount().catch(() => {});
  await migrateOwnedDoctorsClaimed().catch((err) =>
    console.log("[doctors] owned-claimed repair failed:", err),
  );
  await republishReadyDrafts().catch((err) => console.log("[doctors] draft re-publish failed:", err));
  await migrateCentreMembership().catch((err) =>
    console.log("[centreMembership] migration failed:", err),
  );
  // one account, several clinics / hospitals: the unique owner indexes go
  await migrateMultiCentreOwners().catch((err) =>
    console.log("[multiCentre] owner index migration failed:", err),
  );
  // one wallet per clinic / hospital: an owner's centre money moves out of
  // the personal wallet into each centre's (Lib/migrateCentreWallets.ts)
  await migrateCentreWallets().catch((err) =>
    console.log("[centreWallets] migration failed:", err),
  );
  await migrateInsurerKind().catch((err) => console.log("[insurance] isBasic migration failed:", err));
  await migrateInsurerLicense().catch((err) => console.log("[insurance] licence migration failed:", err));
  // the verified tick is a valid licence the staff approved, not an owner
  // account (Services/centreLicenceService.ts); after the insurer licence
  // number copy above
  await migrateCentreLicences().catch((err) => console.log("[centreLicence] migration failed:", err));
  // insurer contracts (2026-10, Lib/insuranceContracts.ts): every insurer a
  // doctor or centre accepted becomes an active contract (idempotent), the
  // read model is reconciled, then the validity / end-date sweep runs
  await migrateInsuranceContracts().catch((err) => console.log("[insuranceContract] migration failed:", err));
  startInsuranceContractJob();
  await migrateLabPharmacyIntegrity().catch((err) =>
    console.log("[labPharmacy] migration failed:", err),
  );
  await migrateDrugPrescriptionStatus().catch((err) =>
    console.log("[drug] prescriptionStatus migration failed:", err),
  );
  // structured opening hours (2026-10): the round-the-clock flag and simple
  // free-text hours become a week (Lib/migrateOpeningHours.ts)
  await migrateOpeningHours().catch((err) =>
    console.log("[openingHours] migration failed:", err),
  );
  // the «شبانه‌روزی» tag becomes the hours' round-the-clock week and goes
  // (Lib/migrateRoundTheClockTags.ts)
  await migrateRoundTheClockTags().catch((err) =>
    console.log("[roundTheClockTags] migration failed:", err),
  );
  // pharmacy delivery area (2026-10): existing pharmacies stay nationwide
  await migratePharmacyShippingScope().catch((err) =>
    console.log("[delivery] shipping scope migration failed:", err),
  );
  await migrateMedicalDirectory().catch((err) =>
    console.log("[directory] medical directory migration failed:", err),
  );
  await mergeLegacyDoctors().catch((err) =>
    console.log("[doctors] merge failed:", err),
  );
  // a doctor's free-text services become catalogue references (2026-10,
  // Lib/migrateDoctorServices.ts); after the legacy merge, which may add some
  await migrateDoctorServices().catch((err) =>
    console.log("[doctorServices] migration failed:", err),
  );
  // Iran's official holidays of 1405-1406 (Lib/publicHolidaySeed.ts); the
  // availability cache of the new days is rebuilt in the background
  await seedPublicHolidays()
    .then((added) => {
      if (added) refreshHolidayDays(seedRows().map((r) => r.ymd)).catch(() => undefined);
    })
    .catch((err) => console.log("[holidays] seed failed:", err));
  startSiteLocalesRefresh();
  await migrateAdminIntegrity().catch((err) =>
    console.log("[migrateAdminIntegrity] failed:", err),
  );
  await migrateBusinessModules().catch((err) =>
    console.log("[business] module migration failed:", err),
  );
  await migrateInventoryModule().catch((err) =>
    console.log("[business] inventory module migration failed:", err),
  );
  await migratePayrollModule().catch((err) =>
    console.log("[business] payroll module migration failed:", err),
  );
  await seedPayrollYears().catch((err) => console.log("[business] payroll years seed failed:", err));
  await migrateCrmModule().catch((err) => console.log("[business] crm module migration failed:", err));
  await migrateMoadianModule().catch((err) => console.log("[business] moadian module migration failed:", err));
  // the three approval stores into the one «کارتابل» (Lib/migrateKartabl.ts)
  await migrateKartabl().catch((err) => console.log("[kartabl] merge failed:", err));
  // receipts and finance scans out of Public/ (Lib/migrateFinanceFiles.ts)
  await migrateFinanceFiles().catch((err) => console.log("[business] private finance files migration failed:", err));
  startCampaignJob();
  startAutomationJob();
  startCrmServiceJob();
  startCrmSalesJob();
  startMoadianJob();
  await migrateLicensePricing().catch((err) =>
    console.log("[licenses] pricing migration failed:", err),
  );
  // aiAssistant module + recommended plans for a kind with none (2026-10)
  await migrateLicensePlans().catch((err) =>
    console.log("[plans] plan migration failed:", err),
  );
  // the AI policy from the old settings, once (2026-10, Lib/migrateAiPolicy.ts)
  await migrateAiPolicy().catch((err) => console.log("[ai] policy migration failed:", err));
  await dedupeDoctorSlugs().catch((err) =>
    console.log("[doctorSlugs] dedupe failed:", err),
  );
  const {
    slugGenerationInterval,
    reservationReminderInterval,
    reservationActivationInterval,
    reservationFinalizationInterval,
    reservationNoShowNudgeInterval,
  } = await getAppConfig();
  startSlugGenerationJob(slugGenerationInterval);
  await runStaleOrderLineSweep().catch(() => {});
  startStaleOrderLineJob();
  // seller response deadlines of pharmacy / lab lines (Lib/orderResponse.ts):
  // older paid orders get theirs first, then the 5-minute sweep
  await migrateOrderResponseDeadlines().catch((err) =>
    console.log("[orders] response deadline migration failed:", err),
  );
  await runOrderResponseSweep().catch((err) =>
    console.log("[orders] response sweep failed:", err),
  );
  startOrderResponseJob();
  // Tipax parcels count as delivered only once confirmed (2026-10,
  // Services/shipmentDeliveryService.ts): older sent parcels get their
  // window (or are delivered past it), then the hourly auto-confirm
  await migrateShipmentDelivery().catch((err) =>
    console.log("[delivery] shipment delivery migration failed:", err),
  );
  startShipmentDeliveryJob();
  // settlements that failed after their state change, retried with backoff
  // (Services/settlementRetryService.ts)
  startSettlementRetryJob();
  // lab sampling appointments (Lib/labSampling.ts): the old «نمونه‌گیری در
  // محل» flag into the new settings once, then the day-before reminders and
  // the seat reconcile every 15 minutes
  await migrateLabSamplingSettings().catch((err) =>
    console.log("[sampling] settings migration failed:", err),
  );
  // appointments booked before moves existed (Lib/labSamplingReschedule.ts)
  await migrateLabSamplingMoves().catch((err) =>
    console.log("[sampling] moves migration failed:", err),
  );
  startLabSamplingJob();
  // provider earnings leave their settlement hold (Lib/payoutHold.ts)
  startPayoutReleaseJob();
  // provider plans ending in 7 days / 1 day / ended: in-app + SMS notice
  startLicenseExpiryJob();
  startCentreLicenceJob();
  // patients' «پرو» memberships: renewal reminders and expiry
  startPatientProJob();
  // the waitlist: ended waits, and the next wave once a head start runs out
  startWaitlistJob();
  // the books of every provider and of the platform (Lib/business)
  startLedgerJob();
  // recurring expenses and cheque due-date reminders (2026-10)
  startFinanceJob();
  await runReservationReminderSweep();
  startReservationReminderJob(reservationReminderInterval);
  // the 24-hour and 2-hour patient reminders (in-app + SMS), same cadence
  await runReservationStageReminderSweep().catch((err) =>
    console.log("[reservationActivation] stage reminder sweep failed:", err),
  );
  startReservationStageReminderJob(reservationReminderInterval);
  await runReservationActivationSweep();
  startReservationActivationJob(reservationActivationInterval);
  await runReservationFinalizationSweep();
  startReservationFinalizationJob(reservationFinalizationInterval);
  await runReservationNoShowNudgeSweep();
  startReservationNoShowNudgeJob(reservationNoShowNudgeInterval);
  startGatewayPaymentSweep();
};

// Online-gateway (SEP) housekeeping - expires abandoned payments and
// re-verifies any interrupted mid-verify (see Services/paymentService.ts).
// Fixed 2-minute cadence: well inside SEP's 30-minute verify window.
const GATEWAY_PAYMENT_SWEEP_INTERVAL = 2 * 60 * 1000;
const startGatewayPaymentSweep = () => {
  const tick = () =>
    runGatewayPaymentSweep().catch((err) =>
      console.log("[payment] gateway payment sweep failed:", err),
    );
  tick();
  setInterval(tick, GATEWAY_PAYMENT_SWEEP_INTERVAL);
};

init();

const server = createServer(app);

let _io: ioServer | null = null;

initCallService(server)
  .then((io) => {
    _io = io;
  })
  .catch((err) => {
    console.log("Failed to start call service (mediasoup/socket.io):");
    console.log(err);
  });

// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import ARI from "ari-client";

import https from "https";
import WebSocket from "ws";
import { IParaClinic } from "./Models/Paraclinic";
import updateDoctorAvailability from "./Lib/updateDoctorAvailablity";
import DoctorAvailability from "./Models/DoctorAvailability";
import { runGatewayPaymentSweep } from "./Services/paymentService";

// const listenForCall = async () => {
//   console.log("start");
//   console.log({
//     SIP_HOST: env.SIP_HOST,
//     uname: env.SIP_USERNAME,
//     pwd: env.SIP_PASSWORD,
//   });

//   try {
//     const client = await ARI.connect(
//       env.SIP_HOST,
//       env.SIP_USERNAME,
//       env.SIP_PASSWORD,
//     );
//     console.log("Sip connected");

//     client.start("ai-agent");

//     client.on("StasisStart", async (event, channel) => {
//       console.log("Call entered AI agent:", channel.id);

//       await channel.play({
//         media: "sound:i-love-you",
//       });
//     });
//     client.on("WebSocketConnected", () => {
//       console.log("WS connected");
//     });

//     client.on("WebSocketReconnecting", () => {
//       console.log("WS reconnecting");
//     });

//     client.on("WebSocketMaxRetries", () => {
//       console.log("WS max retries");
//     });

//     // client.on("ApplicationRegistered", (e) => {
//     //   console.log("registered", e);
//     // });

//     // client.on("ApplicationUnregistered", (e) => {
//     //   console.log("unregistered", e);
//     // });
//   } catch (err) {
//     console.log({ err });
//   }
// };

// listenForCall();

export const io: ioServer | null = _io;

mongoose
  .connect(DB)
  .then(() => {
    console.log(`Database Connected Successfully`);
  })
  .catch((err) => {
    console.log("Database Connection Failed, Reason:");
    console.log(err);
  });

server.listen(env.port, () => {
  console.log(`Listening on port ${env.port}`);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection - exiting process:");
  console.error(reason);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception - exiting process:");
  console.error(err);
  process.exit(1);
});
