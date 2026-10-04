import { NextFunction, Request, RequestHandler, Response } from "express";
import catchAsync from "../Lib/catchAsync";
import OldDoctor from "../Models/Old/oldDoctor";
import Speciality, { ISpeciality } from "../Models/Speciality";
import mongoose from "mongoose";
import OldSpeciality from "../Models/Old/oldSpeciality";
import { cities } from "../Lib/Cities";
import { provinces } from "../Lib/Provinces";
import Doctor from "../Models/Doctor";
import OldPart from "../Models/Old/OldPart";
import Part from "../Models/Part";
import OldBlog from "../Models/Old/OldBlog";
import BlogCategory from "../Models/BlogCategory";
import Blog from "../Models/Blog";
import OldDisease from "../Models/Old/OldDisease";
import OldDrug from "../Models/Old/OldDrug";
import OldSymptom from "../Models/Old/OldSymptom";
import Symptom from "../Models/Symptom";
import Drug from "../Models/Drug";
import { normalizePrescriptionStatus } from "../Lib/migrateDrugPrescriptionStatus";
import Disease from "../Models/Disease";

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
        instagram,
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
                summary: speciality.summary,
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
          instagram,
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

export const importParts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const old = await OldPart.find();
    for (let i = 0; i < old.length; i++) {
      await Part.findOneAndUpdate(
        { old: old[i]._id },
        {
          name: old[i].name,
          order: old[i].order,
          old: old[i]._id,
        },
        { upsert: true }
      );
    }
    res.status(200).json({ message: "importParts" });
  }
);

export const dropParts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Part.deleteMany({ old: { $exists: true, $ne: null } });
    res.status(200).json({ message: "dropParts" });
  }
);

export const purgeParts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Part.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    res.status(200).json({ message: "purgeParts" });
  }
);

export const dropAllParts: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Part.deleteMany();
    res.status(200).json({ message: "dropAllParts" });
  }
);

export const importBlogs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const olds = await OldBlog.find();
    for (let i = 0; i < olds.length; ++i) {
      const { name, slug, summary, mainContent, content, category, _id } =
        olds[i];
      const newCategory = await BlogCategory.findOneAndUpdate(
        { title: category },
        { title: category },
        { upsert: true, new: true }
      );
      await Blog.findOneAndUpdate(
        { old: _id },
        {
          old: _id,
          title: name,
          category: newCategory,
          summary,
          content: mainContent || content,
          slug,
        },
        { upsert: true }
      );
    }
    res.status(200).json({ message: "importBlogs" });
  }
);

export const dropBlogs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Blog.deleteMany({ old: { $exists: true, $ne: null } });
    res.status(200).json({ message: "dropBlogs" });
  }
);

export const purgeBlogs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Blog.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    res.status(200).json({ message: "purgeBlogs" });
  }
);

export const dropAllBlogs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Blog.deleteMany();
    res.status(200).json({ message: "dropAllBlogs" });
  }
);

export const importDiseases: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const olds = await OldDisease.find().populate([
      { path: "drugs", model: OldDrug },
      { path: "specialities", model: OldSpeciality },
      { path: "symptoms", model: OldSymptom },
    ]);
    for (let i = 0; i < olds.length; ++i) {
      const {
        _id,
        name,
        description,
        summary,
        symptoms,
        specialities,
        drugs,
        expectedPrognosis,
        naturalProgression,
        pathophysiology,
        possibleComlplication,
        order,
      } = olds[i];
      //TODO:// 'sameAs' remianing
      const newSymptoms = [];
      for (let j = 0; j < symptoms.length; j++) {
        const oldSymptom = await OldSymptom.findById(symptoms[j]._id);
        if (!oldSymptom) continue;
        const {
          _id,
          name,
          part,
          summary,
          description,
          image,
          naturalProgression,
          pathophysiology,
          possibleComplication,
          order,
        } = oldSymptom;
        const newParts = [];
        for (let k = 0; k < part.length; k++) {
          const oldPart = await OldPart.findById(part[k]._id);
          if (!oldPart) continue;
          const { _id, name, order } = oldPart;
          const newPart = await Part.findOneAndUpdate(
            { old: _id },
            { name, order, old: _id },
            { upsert: true, new: true }
          );
          newParts.push(newPart._id);
        }
        const newSymptom = await Symptom.findOneAndUpdate(
          { old: _id },
          {
            old: _id,
            name,
            part: newParts,
            summary,
            description,
            image,
            naturalProgression,
            pathophysiology,
            possibleComplication,
            order,
          },
          { upsert: true, new: true }
        );
        newSymptoms.push(newSymptom._id);
      }
      const newSpecialities = [];
      for (let j = 0; j < specialities.length; j++) {
        const oldSpeciality = await OldSpeciality.findById(specialities[j]);
        if (!oldSpeciality) continue;
        const { _id, name, image, order, summary } = oldSpeciality;
        const newSpeciality = await Speciality.findOneAndUpdate(
          { old: _id },
          { old: _id, name, image, order, summary, active: true },
          { upsert: true, new: true }
        );
        newSpecialities.push(newSpeciality._id);
      }
      const newDrugs = [];
      for (let j = 0; j < drugs.length; j++) {
        const oldDrug = await OldDrug.findById(drugs[j]._id);
        if (!oldDrug) continue;
        const {
          _id,
          name,
          summary,
          description,
          sideEffects,
          activeIngridient,
          adminstrationRoute,
          alcoholWarning,
          alternateName,
          breastfeedingWarning,
          clinicalPharmacology,
          dosageForm,
          drugUnit,
          foodWarning,
          identifier,
          image,
          overdosage,
          pregnancyWarning,
          prescribingInfo,
          prescriptionStatus,
          warning,
          order,
        } = oldDrug;
        const newDrug = await Drug.findOneAndUpdate(
          { old: _id },
          {
            name,
            summary,
            description,
            sideEffects,
            activeIngridient,
            adminstrationRoute,
            alcoholWarning,
            alternateName,
            breastfeedingWarning,
            clinicalPharmacology,
            dosageForm,
            drugUnit,
            foodWarning,
            identifier,
            image,
            overdosage,
            pregnancyWarning,
            prescribingInfo,
            prescriptionStatus: normalizePrescriptionStatus(prescriptionStatus),
            warning,
            order,
            old: _id,
          },
          { upsert: true, new: true }
        );
        newDrugs.push(newDrug._id);
      }
      await Disease.findOneAndUpdate(
        { old: _id },
        {
          old: _id,
          name,
          description,
          summary,
          symptoms: newSymptoms,
          specialities: newSpecialities,
          drugs: newDrugs,
          expectedPrognosis,
          naturalProgression,
          pathophysiology,
          possibleComplication: possibleComlplication,
          order,
        },
        { upsert: true }
      );
    }
    res.status(200).json({ message: "importDiseases" });
  }
);

export const dropDiseases: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Disease.deleteMany({ old: { $exists: true, $ne: null } });
    res.status(200).json({ message: "dropDiseases" });
  }
);

export const purgeDiseases: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Disease.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    res.status(200).json({ message: "purgeDiseases" });
  }
);

export const dropAllDiseases: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Disease.deleteMany();
    res.status(200).json({ message: "dropAllDiseases" });
  }
);

export const importDrugs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const olds = await OldDrug.find();
    for (let i = 0; i < olds.length; i++) {
      const {
        _id,
        name,
        summary,
        description,
        sideEffects,
        activeIngridient,
        adminstrationRoute,
        alcoholWarning,
        alternateName,
        breastfeedingWarning,
        clinicalPharmacology,
        dosageForm,
        drugUnit,
        foodWarning,
        identifier,
        image,
        overdosage,
        pregnancyWarning,
        prescribingInfo,
        prescriptionStatus,
        warning,
        order,
      } = olds[i];
      await Drug.findOneAndUpdate(
        { old: _id },
        {
          name,
          summary,
          description,
          sideEffects,
          activeIngridient,
          adminstrationRoute,
          alcoholWarning,
          alternateName,
          breastfeedingWarning,
          clinicalPharmacology,
          dosageForm,
          drugUnit,
          foodWarning,
          identifier,
          image,
          overdosage,
          pregnancyWarning,
          prescribingInfo,
          prescriptionStatus: normalizePrescriptionStatus(prescriptionStatus),
          warning,
          order,
        },
        { upsert: true }
      );
    }
    res.status(200).json({ message: "importDrugs" });
  }
);

export const dropDrugs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Drug.deleteMany({ old: { $exists: true, $ne: null } });
    res.status(200).json({ message: "dropDrugs" });
  }
);

export const purgeDrugs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Drug.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    res.status(200).json({ message: "purgeDrugs" });
  }
);

export const dropAllDrugs: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Drug.deleteMany();
    res.status(200).json({ message: "dropAllDrugs" });
  }
);

export const importSpecialities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const olds = await OldSpeciality.find();
    for (let i = 0; i < olds.length; i++) {
      const { _id, name, image, order, summary } = olds[i];
      await Speciality.findOneAndUpdate(
        { old: _id },
        { old: _id, name, image, order, summary },
        { upsert: true }
      );
    }
    res.status(200).json({ message: "importSpecialities" });
  }
);

export const dropSpecialities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Speciality.deleteMany({ old: { $exists: true, $ne: null } });
    res.status(200).json({ message: "dropSpecialities" });
  }
);

export const purgeSpecialities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Speciality.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    res.status(200).json({ message: "purgeSpecialities" });
  }
);

export const dropAllSpecialities: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Speciality.deleteMany();
    res.status(200).json({ message: "dropAllSpecialities" });
  }
);

export const importSymptoms: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const olds = await OldSymptom.find();
    for (let i = 0; i < olds.length; i++) {
      const {
        _id,
        name,
        part,
        summary,
        description,
        image,
        naturalProgression,
        pathophysiology,
        possibleComplication,
        order,
      } = olds[i];
      const newParts = [];
      for (let k = 0; k < part.length; k++) {
        const oldPart = await OldPart.findById(part[k]._id);
        if (!oldPart) continue;
        const { _id, name, order } = oldPart;
        const newPart = await Part.findOneAndUpdate(
          { old: _id },
          { name, order, old: _id },
          { upsert: true, new: true }
        );
        newParts.push(newPart._id);
      }
      await Symptom.findOneAndUpdate(
        { old: _id },
        {
          old: _id,
          name,
          part: newParts,
          summary,
          description,
          image,
          naturalProgression,
          pathophysiology,
          possibleComplication,
          order,
        },
        { upsert: true }
      );
    }
    res.status(200).json({ message: "importSymptoms" });
  }
);

export const dropSymptoms: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Symptom.deleteMany({ old: { $exists: true, $ne: null } });
    res.status(200).json({ message: "dropSymptoms" });
  }
);

export const purgeSymptoms: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Symptom.updateMany(
      { old: { $exists: true, $ne: null } },
      { $unset: { old: 1 } }
    );
    res.status(200).json({ message: "purgeSymptoms" });
  }
);

export const dropAllSymptoms: RequestHandler = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    await Symptom.deleteMany();
    res.status(200).json({ message: "deleteAllSymptoms" });
  }
);
