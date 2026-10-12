import mongoose, { Model } from "mongoose";
import { clearsSeoCache } from "../Lib/seo/seoCache";
import { MongoDoc } from "./User";
import { translatable } from "../Lib/i18n/translatable";

// The super admin's SEO template for one page type (2026-10), e.g.
// "/dr/[slug]" or "/clinic". A saved template replaces the built-in one
// (Lib/seo/seoDefaults.ts); see Lib/seo/seoResolver.ts for the syntax.
export interface ISeoTemplate extends MongoDoc {
  resourceType: string;
  title?: string;
  description?: string;
  keywords?: string[];
  // e.g. keep thin listing pages out of the index
  noIndex?: boolean;
  // the automatic FAQ block + FAQPage data of a profile page type
  // (Lib/autoFaq.ts); only `false` switches it off
  autoFaq?: boolean;
  updatedAt?: Date;
}

const SeoTemplateSchema = new mongoose.Schema<ISeoTemplate, Model<ISeoTemplate>>(
  {
    resourceType: { type: String, required: true, unique: true },
    title: { type: String, trim: true, maxlength: 300 },
    description: { type: String, trim: true, maxlength: 1000 },
    keywords: { type: [String], default: undefined },
    noIndex: { type: Boolean, default: false },
    autoFaq: { type: Boolean },
  },
  { timestamps: true },
);

SeoTemplateSchema.plugin(translatable);
clearsSeoCache(SeoTemplateSchema);

const SeoTemplate = mongoose.model("SeoTemplate", SeoTemplateSchema);

export default SeoTemplate;
