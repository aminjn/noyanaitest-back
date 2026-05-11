import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITaminSpec extends MongoDoc {
  specCode: string;
  specDesc: string;
  specGRP: string;
  docComment: null;
  status: string;
  statusstDate: string;
  typeSpec: null;
  maxNormal: null;
  maxSpecial: null;
  lstatus: string;
}

const TaminSpecSchema = new mongoose.Schema<ITaminSpec, Model<ITaminSpec>>({
  specCode: { type: String },
  specDesc: { type: String },
  specGRP: { type: String },
  docComment: { type: String },
  status: { type: String },
  statusstDate: { type: String },
  typeSpec: { type: String },
  maxNormal: { type: String },
  maxSpecial: { type: String },
  lstatus: { type: String },
});

const TaminSpec = mongoose.model("TaminSpec", TaminSpecSchema);

export default TaminSpec;
