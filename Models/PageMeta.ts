import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { clearsSeoCache } from "../Lib/seo/seoCache";
import { MongoDoc } from "./User";

// every listing page in the app, e.g. /symptom
export const pageMetaListResourceTypes = [
  "/mag",
  "/doctors",
  "/disease",
  "/drug",
  "/speciality",
  "/clinic",
  "/hospital",
  "/paraClinic",
  "/test",
  "/pharmacy",
  "/service",
  "/product",
  "/symptom",
  "/insurance",
  "/faq",
  "/",
  "/book",
  "/about",
  "/contact",
  "/policy",
  "/privacy",
  "/map",
  "/become/doctor",
  "/become/clinic",
  "/become/hospital",
  "/become/insurance",
  "/become/paraClinic",
  "/become/pharmacy",
] as const;

// every single-document page in the app, e.g. /symptom/[slug]
export const pageMetaNodeResourceTypes = [
  "/mag/[blogSlug]",
  "/dr/[slug]",
  "/disease/[slug]",
  "/drug/[slug]",
  "/speciality/[slug]",
  "/clinic/[slug]",
  "/hospital/[slug]",
  "/paraClinic/[slug]",
  "/pharmacy/[slug]",
  "/product/[slug]",
  "/productPackage/[slug]",
  "/symptom/[slug]",
  "/service/[slug]",
  "/servicePackage/[slug]",
  "/insurance/[slug]",
  "/test/[slug]",
] as const;

export const pageMetaResourceTypes = [
  ...pageMetaListResourceTypes,
  ...pageMetaNodeResourceTypes,
] as const;

export type PageMetaListResourceType =
  (typeof pageMetaListResourceTypes)[number];
export type PageMetaNodeResourceType =
  (typeof pageMetaNodeResourceTypes)[number];
export type PageMetaResourceType = (typeof pageMetaResourceTypes)[number];

export const isNodeResourceType = (
  resourceType: string,
): resourceType is PageMetaNodeResourceType =>
  (pageMetaNodeResourceTypes as readonly string[]).includes(resourceType);

export const isListResourceType = (
  resourceType: string,
): resourceType is PageMetaListResourceType =>
  (pageMetaListResourceTypes as readonly string[]).includes(resourceType);

export interface IPageMeta extends MongoDoc {
  // which page this record belongs to; list pages take no slug, node pages require one
  resourceType: PageMetaResourceType;
  // required for node resourceTypes, identifies the specific document (its slug)
  slug?: string;
  // for node records, optional link back to the source document
  resourceModel?: string;
  resource?: mongoose.Types.ObjectId;
  title?: string;
  description?: string;
  keywords?: string[];
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  canonicalUrl?: string;
  // schema.org / JSON-LD structured data
  webSchema?: Record<string, any>;
  noIndex?: boolean;
  noFollow?: boolean;
}

const PageMetaSchema = new mongoose.Schema<IPageMeta, Model<IPageMeta>>(
  {
    resourceType: {
      type: String,
      enum: pageMetaResourceTypes,
      required: true,
    },
    slug: {
      type: String,
      validate: {
        validator(this: IPageMeta, value: string | undefined) {
          return isNodeResourceType(this.resourceType)
            ? !!value
            : value === undefined;
        },
        message:
          "slug is required for node pages and must be omitted for list pages",
      },
    },
    resourceModel: { type: String },
    resource: { type: mongoose.Schema.ObjectId, refPath: "resourceModel" },
    title: { type: String },
    description: { type: String },
    keywords: { type: [String], default: [] },
    ogTitle: { type: String },
    ogDescription: { type: String },
    ogImage: { type: String },
    canonicalUrl: { type: String },
    webSchema: { type: mongoose.Schema.Types.Mixed },
    noIndex: { type: Boolean, default: false },
    noFollow: { type: Boolean, default: false },
  },
  { timestamps: true },
);

PageMetaSchema.index(
  { resourceType: 1, slug: 1 },
  { unique: true, sparse: true },
);

PageMetaSchema.plugin(translatable);
clearsSeoCache(PageMetaSchema);

const PageMeta = mongoose.model("PageMeta", PageMetaSchema);

export default PageMeta;
