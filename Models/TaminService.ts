import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITaminService extends MongoDoc {
  srvId?: string;
  srvType?: string;
  srvCode?: string;
  srvName?: string;
  srvName2?: string;
  srvBimSw?: string;
  srvSex?: string;
  srvPrice?: string;
  srvPriceDate?: string;
  doseCode?: string;
  formCode?: string;
  parTarefGrp?: string;
  status?: string;
  statusstDate?: string;
  bGType?: string;
  gSrvCode?: string;
  agreementFlag?: string;
  isDeleted?: string;
  visible?: string;
  dentalServiceType?: string;
  wsSrvCode?: string;
  hosprescType?: string;
  srvRule?: string;
  countIsRestricted?: string;
  drugWarning?: string;
  terminology?: string;
  srvCodeComplete?: string;
}

const TaminServiceSchema = new mongoose.Schema<
  ITaminService,
  Model<ITaminService>
>({
  srvId: { type: String },
  srvType: { type: String },
  srvCode: { type: String },
  srvName: { type: String },
  srvName2: { type: String },
  srvBimSw: { type: String },
  srvSex: { type: String },
  srvPrice: { type: String },
  srvPriceDate: { type: String },
  doseCode: { type: String },
  formCode: { type: String },
  parTarefGrp: { type: String },
  status: { type: String },
  statusstDate: { type: String },
  bGType: { type: String },
  gSrvCode: { type: String },
  agreementFlag: { type: String },
  isDeleted: { type: String },
  visible: { type: String },
  dentalServiceType: { type: String },
  wsSrvCode: { type: String },
  hosprescType: { type: String },
  srvRule: { type: String },
  countIsRestricted: { type: String },
  drugWarning: { type: String },
  terminology: { type: String },
  srvCodeComplete: { type: String },
});

const TaminService = mongoose.model("TaminService", TaminServiceSchema);

export default TaminService;
