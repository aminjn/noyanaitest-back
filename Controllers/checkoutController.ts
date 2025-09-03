import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import AppError, {
  BadInputError,
  MiddlewareError,
  NotFoundError,
  ServerError,
} from "../Lib/AppError";
import { isValidObjectId } from "mongoose";
import Invoice from "../Models/Invoice";
import { NODE_ENV } from "../Lib/Env";
import InvoiceCheckout from "../Models/InvocieCheckout";
import DoctorSession from "../Models/DoctorSession";
import Booking, { IBooking } from "../Models/Booking";
import Chat from "../Models/Chat";
import moment from "moment-jalaali";
import { numberToTime } from "../Lib/helpers";

export const payInvoice: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(new MiddlewareError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const node = await Invoice.findOne({
      _id: nodeId,
      user: req.user._id,
    }).populate({ path: "checkout" });
    if (!node) return next(new NotFoundError());
    if (!node.payable)
      return next(new AppError("این فاکتور قابل پرداخت نیست.", 400));
    if (!!node.checkout)
      return next(new AppError("این فاکتور قبلا پرداخت شده است.", 400));
    res.status(200).json({ message: "payInvoice" });
  }
);

export const settleInvoice: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    //TODO: add Banking shit here later
    if (NODE_ENV === "production") return next(new NotFoundError());
    if (!req.user) return next(new MiddlewareError());
    if (req.body.secret !== "HAJI") return next(new NotFoundError());
    const { nodeId } = req.params;
    if (!isValidObjectId(nodeId)) return next(new BadInputError());
    const invoice = await Invoice.findOne({
      _id: nodeId,
      user: req.user._id,
    }).populate({ path: "checkout" });
    if (!invoice) return next(new NotFoundError());
    if (!!invoice.checkout)
      return next(new AppError("این فاکتور قبلا تسویه شده است.", 400));
    if (!invoice.payable)
      return next(new AppError("این فاکتور قابل پرداخت نیست.", 400));
    let data: IBooking | undefined;
    if (invoice.session) {
      if (!invoice.sessionKind) return next(new ServerError());
      const session = await DoctorSession.findById(invoice.session).populate([
        {
          path: "booking",
        },
        { path: "doctor" },
      ]);
      const fail = async (message: string) => {
        await Invoice.findByIdAndUpdate(invoice._id, { payable: false });
        return next(new AppError(message, 400));
      };
      if (!session) return fail("این جلسه حذف شده است.");
      if (!!session.booking) return fail("این جلسه زودتر از شما رزرو شده است");
      if (!session[invoice.sessionKind])
        return fail("امکان رزرو با روش انتخابی شما برداشته شده است");
      if (!session.doctor.user)
        return fail("این پزشک با نویان قطع همکاری کرده");
      data = await Booking.create({
        session: session._id,
        user: req.user._id,
        bookPrice: invoice.total,
        kind: invoice.sessionKind,
        doctor: session.doctor,
      });
      if (invoice.sessionKind === "textChat") {
        const chatStart = moment(
          `${session.date}-${numberToTime(session.start)}`,
          "YYYY/MM/DD-hh:mm"
        ).toDate();
        await Chat.create({
          participants: [req.user._id, session.doctor.user?._id],
          opensAt: chatStart,
        });
      }
    }
    await InvoiceCheckout.create({
      invoice: invoice._id,
      paymentMethod: "Manual",
    });
    res.status(200).json({ message: "settleInvoice", data });
  }
);
