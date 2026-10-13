import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

// One merge of the catalogue clean-up (Services/catalogCleanup.ts): which
// entries went into which, every record whose reference moved, and the
// state before - enough to undo it within 30 days.
export interface ICatalogMerge extends MongoDoc {
  kind: "speciality" | "disease" | "service";
  target: mongoose.Types.ObjectId;
  sources: mongoose.Types.ObjectId[];
  moved: { model: string; field: string; doc: mongoose.Types.ObjectId; from: mongoose.Types.ObjectId }[];
  before?: {
    synonyms: string[];
    states: { id: mongoose.Types.ObjectId; active: boolean; mergedInto?: mongoose.Types.ObjectId | null }[];
  };
  by?: mongoose.Types.ObjectId;
  undoneAt?: Date;
  createdAt: Date;
}

const CatalogMergeSchema = new mongoose.Schema<ICatalogMerge, Model<ICatalogMerge>>(
  {
    kind: { type: String, enum: ["speciality", "disease", "service"], required: true },
    target: { type: mongoose.Schema.ObjectId, required: true },
    sources: { type: [mongoose.Schema.ObjectId], default: [] },
    moved: {
      type: [
        {
          _id: false,
          model: String,
          field: String,
          doc: mongoose.Schema.ObjectId,
          from: mongoose.Schema.ObjectId,
        },
      ],
      default: [],
    },
    before: { type: mongoose.Schema.Types.Mixed },
    by: { type: mongoose.Schema.ObjectId, ref: "User" },
    undoneAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

CatalogMergeSchema.index({ kind: 1, createdAt: -1 });

const CatalogMerge = mongoose.model("CatalogMerge", CatalogMergeSchema);

export default CatalogMerge;
