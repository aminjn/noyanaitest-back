import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITaminParTaref extends MongoDoc {
  parGrpCode?: string;
  parGrpDesc?: string;
  parGrpRem?: string;
  status?: string;
  statusStDate?: string;
}

const TaminParTarefSchema = new mongoose.Schema<
  ITaminParTaref,
  Model<ITaminParTaref>
>({
  parGrpCode: { type: String },
  parGrpDesc: { type: String },
  parGrpRem: { type: String },
  status: { type: String },
  statusStDate: { type: String },
});

const TaminParTaref = mongoose.model("TaminParTaref", TaminParTarefSchema);

export default TaminParTaref;
