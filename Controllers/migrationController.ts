import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import OldDoctor from "../Models/Old/oldDoctor";
import Speciality, { ISpeciality } from "../Models/Speciality";
import mongoose from "mongoose";
import OldSpeciality from "../Models/Old/oldSpeciality";
import { cities } from "../Lib/Cities";
import { provinces } from "../Lib/Provinces";
import Doctor from "../Models/Doctor";

export const importDoctors: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const doctors = await OldDoctor.find().populate([
      { path: "speciality", model: OldSpeciality },
      { path: "specialities", model: OldSpeciality },
    ]);
    for (let i = 0; i < doctors.length; ++i) {
      const {
        _id,
        name,
        image,
        code,
        hours,
        awards,
        birthDate,
        description,
        summary,
        images,
        order,
        active,
        address,
        landLine,
        mobile,
        lng,
        lat,
        email,
        province: _province,
        newCity: _city,
        link: site,
        telegram,
        twitter,
        youtube,
        aparat,
        linkedin,
      } = doctors[i];
      const speciality = doctors[i].speciality;
      const specialities = doctors[i].specialities;
      const newSpeciality = speciality
        ? (
            await Speciality.findOneAndUpdate(
              { old: speciality._id },
              {
                name: speciality.name,
                image: speciality.image,
                order: speciality.order,
                summary: speciality.order,
                active: true,
                old: speciality._id,
              },
              { upsert: true, new: true }
            )
          )._id
        : undefined;
      const newSpecialities = await Promise.all(
        specialities.map(
          async (spec) =>
            (
              await Speciality.findOneAndUpdate(
                { old: spec._id },
                {
                  old: spec._id,
                  name: spec.name,
                  image: spec.image,
                  order: spec.order,
                  summary: spec.summary,
                  active: true,
                },
                { upsert: true, new: true }
              )
            )._id
        )
      );
      const city = cities.find((c) => c.name === _city)?.slug;
      const province = provinces.find((p) => p.name === _province)?.slug;
      await Doctor.findOneAndUpdate(
        { old: _id },
        {
          name,
          image,
          code,
          hours,
          awards,
          birthDate,
          description,
          summary,
          images,
          order,
          active,
          address,
          landLine,
          mobile,
          lng,
          lat,
          email,
          province,
          city,
          site,
          telegram,
          twitter,
          youtube,
          aparat,
          linkedin,
          speciality: newSpeciality,
          specialities: newSpecialities,
          old: _id,
        },
        { upsert: true }
      );
    }
    res.status(200).json({ message: "importDoctors" });
  }
);

export const dropDoctors: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Doctor.deleteMany({ old: { $exists: true, $ne: null } });
    res.status(200).json({ message: "dropDoctors" });
  }
);

export const purgeDoctors: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Doctor.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    res.status(200).json({ message: "purgeDoctors" });
  }
);

export const dropAllDoctors: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Doctor.deleteMany();
    res.status(200).json({ message: "dropAllDoctors" });
  }
);
