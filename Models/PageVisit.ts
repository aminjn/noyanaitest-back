import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";
import { IVisitorIdentity } from "./VisitorIdentity";

// A single (deduplicated) visit of a page by a VisitorIdentity.
// `visitedAt` is when the window started, `lastVisitedAt` is the most
// recent hit that fell inside the window, and `count` tracks how many
// hits were folded into this record. See analyticsController.trackVisit
// for the upsert/window logic that keeps this deduplicated.
export interface IPageVisit extends MongoDoc {
  identity: IVisitorIdentity;
  page: string;
  visitedAt: Date;
  lastVisitedAt: Date;
  count: number;
}

const PageVisitSchema = new mongoose.Schema<IPageVisit, Model<IPageVisit>>({
  identity: {
    type: mongoose.Schema.ObjectId,
    ref: "VisitorIdentity",
    required: true,
  },
  page: { type: String, required: true },
  visitedAt: { type: Date, required: true, default: () => new Date() },
  lastVisitedAt: { type: Date, required: true, default: () => new Date() },
  count: { type: Number, default: 1 },
});

// Fast lookup for the upsert-with-window query in analyticsController,
// and for querying a visitor's/page's history.
PageVisitSchema.index({ identity: 1, page: 1, lastVisitedAt: -1 });

const PageVisit = mongoose.model("PageVisit", PageVisitSchema);

export default PageVisit;
