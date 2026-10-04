// SMS for every event a patient or a provider must know about (2026-10).
// In Iran SMS is the primary channel (push needs foreign app stores, many
// users never install the app), so - like Paziresh24, Doctolib's own SMS
// and Digikala's order SMS - every state change that touches someone's
// appointment, money, order, request or account also goes out as an IPPanel
// pattern SMS, next to the in-app / push Notification.
//
// Each entry gets its own SmsPatterns field (Models/SmsPatterns.ts derives
// one per entry through Lib/smsPatternName.ts, e.g. "walletChargedUser" ->
// "WALLET_CHARGED_USER_PATTERN"), the same way userAlertEvents,
// reservationSmsEvents and orderSmsEvents do. A pattern the admin leaves
// empty means "no SMS for this event" (Lib/sendSms.ts logs it as skipped).
//
// Sent through Services/notificationSmsService.ts's notifyWithSms. To add
// an event: add it here, give it a variables shape in NotificationSmsVariables
// below and an audience in notificationSmsAudience, call notifyWithSms where
// it happens, and mirror it on the admin patterns page (frontend
// Components/Admin/SmsPatterns/smsPatternCatalog.ts: title, variables,
// sample text).
export const notificationSmsEvents = [
  // ---------------------------------------------------------- appointments
  // The doctor or support cancelled the patient's appointment -
  // Services/reservationCancelService.ts (by "doctor"),
  // Controllers/adminReservationController.ts cancelReservationByAdmin.
  "reservationCancelledPatient",
  // The patient or support cancelled one of the doctor's appointments.
  "reservationCancelledDoctor",
  // The appointment was moved to another time - by the doctor's desk
  // (Controllers/doctorDeskController.ts moveReservation) or by support.
  "reservationRescheduledPatient",
  // Support moved one of the doctor's appointments.
  "reservationRescheduledDoctor",
  // Money for an appointment went back to the booker's wallet: support
  // refund / dispute upheld, the doctor did not show, or the visit could
  // not take place (Services/reservationProgressService.ts refundPatient).
  "reservationRefundedPatient",
  // The patient missed the visit, the doctor was paid (no refund).
  "reservationNoShowPatient",
  // The doctor missed the visit; the patient was refunded.
  "reservationNoShowDoctor",
  // Support ruled a no-show / error / disputed visit as done and paid it.
  "reservationCompletedBySupportDoctor",
  // Support ruled for the patient and took back the doctor's payout.
  "reservationPayoutReversedDoctor",
  // The doctor wrote the patient's instructions for a visit
  // (Controllers/visitController.ts saveVisitNote, first time only).
  "visitNoteReadyPatient",

  // ---------------------------------------------------------------- orders
  // A pharmacy entered the shipment's tracking code.
  "orderShippedUser",
  // A seller fulfilled (prepared / delivered) items of the order.
  "orderItemFulfilledUser",
  // Items of the order were cancelled (seller, support or the 7-day stale
  // sweep) and refunded to the wallet.
  "orderItemCancelledUser",
  // The pharmacy rejected the prescription of an Rx line, which is then
  // cancelled and refunded (Controllers/pharmacyController.ts).
  "prescriptionRejectedUser",
  // A lab uploaded the test result.
  "labResultReadyUser",
  // The buyer (or support for the buyer) cancelled an item before it was
  // prepared - the seller must not send it.
  "orderCancelledByBuyerSeller",

  // ----------------------------------------------------------------- money
  // A bank-gateway wallet top-up was verified and credited
  // (Services/paymentService.ts, purpose "walletCharge").
  "walletChargedUser",
  // Support resolved a stuck gateway payment: credited to the wallet, or
  // returned to the bank card (Controllers/adminFinanceController.ts).
  "gatewayPaymentCreditedUser",
  "gatewayPaymentRefundedUser",
  // Support adjusted the wallet by hand (Controllers/adminWalletController.ts).
  "walletCreditedUser",
  "walletDebitedUser",
  // A withdrawal request was paid out / rejected (Controllers/withdrawalController.ts).
  "withdrawalPaidProvider",
  "withdrawalRejectedProvider",
  // Earnings left the settlement hold and are withdrawable (Lib/payoutHold.ts).
  "payoutReleasedProvider",

  // ------------------------------------------------------ provider requests
  // A "become a doctor / pharmacy / clinic / ..." request was approved
  // (Controllers/adminEntityController.ts approveBecome*).
  "providerRequestApprovedProvider",
  // Any request in the /requests queue was rejected with a reason
  // (Controllers/adminRequestsController.ts rejectRequest).
  "providerRequestRejectedProvider",
  // A doctor's membership in a clinic / hospital was approved or rejected
  // (admin, or the centre itself - Controllers/centerDoctorsController.ts).
  "centreMembershipApprovedDoctor",
  "centreMembershipRejectedDoctor",
  // A clinic / hospital invited the doctor.
  "centreInvitationDoctor",
  // A clinic / hospital removed the doctor.
  "centreMembershipEndedDoctor",
  // A centre the doctor asked to add was created and the doctor linked to it.
  "additionRequestDoneDoctor",
  // Support suspended / reinstated a provider page, or made the account its
  // owner (Controllers/adminProviderController.ts).
  "providerSuspendedProvider",
  "providerReinstatedProvider",
  "providerOwnerAssignedProvider",
  // A provider's SMS campaign was approved / could not be sent
  // (Lib/business/campaign.ts).
  "smsCampaignApprovedProvider",
  "smsCampaignFailedProvider",
  // A provider's article was approved (published) or rejected
  // (Controllers/adminSupportController.ts moderateBlogs).
  "articleApprovedProvider",
  "articleRejectedProvider",

  // -------------------------------------------------------------- licences
  // A plan was bought (Controllers/*Controller.ts purchaseLicense), will
  // expire in 7 days / 1 day, or has expired
  // (Services/licenseExpiryService.ts, hourly).
  "licensePurchasedProvider",
  "licenseExpiringProvider",
  "licenseExpiredProvider",

  // --------------------------------------------------------------- account
  // Support answered the user's ticket (Models/TicketMessage.ts).
  "ticketAnsweredUser",
  // The account was suspended / reactivated (Controllers/adminUserController.ts).
  // A suspended account can't sign in, so SMS is the only way to tell them.
  "accountSuspendedUser",
  "accountReactivatedUser",
] as const;

export type NotificationSmsEvent = (typeof notificationSmsEvents)[number];

// Who receives each event - drives the grouping on the admin patterns page
// (mirrored there) and nothing else.
export type SmsAudience = "patient" | "provider" | "staff";

export const notificationSmsAudience: Record<NotificationSmsEvent, SmsAudience> = {
  reservationCancelledPatient: "patient",
  reservationCancelledDoctor: "provider",
  reservationRescheduledPatient: "patient",
  reservationRescheduledDoctor: "provider",
  reservationRefundedPatient: "patient",
  reservationNoShowPatient: "patient",
  reservationNoShowDoctor: "provider",
  reservationCompletedBySupportDoctor: "provider",
  reservationPayoutReversedDoctor: "provider",
  visitNoteReadyPatient: "patient",
  orderShippedUser: "patient",
  orderItemFulfilledUser: "patient",
  orderItemCancelledUser: "patient",
  prescriptionRejectedUser: "patient",
  labResultReadyUser: "patient",
  orderCancelledByBuyerSeller: "provider",
  walletChargedUser: "patient",
  gatewayPaymentCreditedUser: "patient",
  gatewayPaymentRefundedUser: "patient",
  walletCreditedUser: "patient",
  walletDebitedUser: "patient",
  withdrawalPaidProvider: "provider",
  withdrawalRejectedProvider: "provider",
  payoutReleasedProvider: "provider",
  providerRequestApprovedProvider: "provider",
  providerRequestRejectedProvider: "provider",
  centreMembershipApprovedDoctor: "provider",
  centreMembershipRejectedDoctor: "provider",
  centreInvitationDoctor: "provider",
  centreMembershipEndedDoctor: "provider",
  additionRequestDoneDoctor: "provider",
  providerSuspendedProvider: "provider",
  providerReinstatedProvider: "provider",
  providerOwnerAssignedProvider: "provider",
  smsCampaignApprovedProvider: "provider",
  smsCampaignFailedProvider: "provider",
  articleApprovedProvider: "provider",
  articleRejectedProvider: "provider",
  licensePurchasedProvider: "provider",
  licenseExpiringProvider: "provider",
  licenseExpiredProvider: "provider",
  ticketAnsweredUser: "patient",
  accountSuspendedUser: "patient",
  accountReactivatedUser: "patient",
};

// The {placeholder} names each pattern's text may use - IPPanel substitutes
// them by name, so these keys must match the pattern exactly (the admin page
// shows them). Every value is a plain string: amounts are Latin-digit
// tomans ("250000"), dates are jalali "1405/07/12", times "HH:mm".
// `kind` / `centre` / `title` values that are Persian catalog words (an org
// kind such as «کلینیک») are translated into the language the pattern is
// sent in; names, reasons and codes are sent as written.
export type NotificationSmsVariables = {
  reservationCancelledPatient: {
    reservationId: string;
    doctorName: string;
    date: string;
    time: string;
    amount: string;
  };
  reservationCancelledDoctor: {
    reservationId: string;
    patientName: string;
    date: string;
    time: string;
  };
  reservationRescheduledPatient: {
    reservationId: string;
    doctorName: string;
    date: string;
    time: string;
  };
  reservationRescheduledDoctor: {
    reservationId: string;
    patientName: string;
    date: string;
    time: string;
  };
  reservationRefundedPatient: { reservationId: string; amount: string };
  reservationNoShowPatient: { reservationId: string; doctorName: string; date: string };
  reservationNoShowDoctor: { reservationId: string; date: string };
  reservationCompletedBySupportDoctor: { reservationId: string };
  reservationPayoutReversedDoctor: { reservationId: string; amount: string };
  visitNoteReadyPatient: { reservationId: string; doctorName: string };
  orderShippedUser: { orderId: string; sellerName: string; trackingCode: string };
  orderItemFulfilledUser: { orderId: string };
  orderItemCancelledUser: { orderId: string };
  prescriptionRejectedUser: { orderId: string; pharmacyName: string; reason: string };
  labResultReadyUser: { orderId: string; labName: string };
  orderCancelledByBuyerSeller: { orderId: string };
  walletChargedUser: { amount: string };
  gatewayPaymentCreditedUser: { amount: string };
  gatewayPaymentRefundedUser: { amount: string };
  walletCreditedUser: { amount: string; reason: string };
  walletDebitedUser: { amount: string; reason: string };
  withdrawalPaidProvider: { amount: string; trackingCode: string };
  withdrawalRejectedProvider: { amount: string; reason: string };
  payoutReleasedProvider: { amount: string };
  providerRequestApprovedProvider: { kind: string };
  providerRequestRejectedProvider: { title: string; reason: string };
  centreMembershipApprovedDoctor: { centre: string };
  centreMembershipRejectedDoctor: { centre: string; reason: string };
  centreInvitationDoctor: { centre: string };
  centreMembershipEndedDoctor: { centre: string };
  additionRequestDoneDoctor: { centre: string };
  providerSuspendedProvider: { kind: string; name: string; reason: string };
  providerReinstatedProvider: { kind: string; name: string };
  providerOwnerAssignedProvider: { kind: string; name: string };
  smsCampaignApprovedProvider: { name: string };
  smsCampaignFailedProvider: { name: string; reason: string };
  articleApprovedProvider: { title: string };
  articleRejectedProvider: { title: string; reason: string };
  licensePurchasedProvider: { plan: string; expiresAt: string };
  licenseExpiringProvider: { plan: string; days: string; expiresAt: string };
  licenseExpiredProvider: { plan: string };
  ticketAnsweredUser: { ticketId: string; ticketTitle: string };
  accountSuspendedUser: { reason: string; until: string };
  accountReactivatedUser: Record<string, never>;
};
