// Default SEO templates (2026-10). One per page type instead of one entry
// per doctor / pharmacy / drug: the resolver (Lib/seo/seoResolver.ts) fills
// `{variable}` from the record, and a `[ ... ]` part is dropped when any
// variable inside it is empty ("[ در {city}]" disappears for a doctor with
// no city). The super admin edits these in «سئو و لینک‌ها» > «سئوی خودکار»
// and translates them like any content; a record's own SEO entry still
// wins field by field.
//
// Titles carry no brand: the site layout appends " | <brand>". Patterns
// follow what ranks for the leaders (Paziresh24 / Doctoralia / Zocdoc
// "Dr X, cardiologist in Tehran - book online", Vezeeta / Halodoc
// "Pharmacy X in Y - order online", Drugs.com "X: uses, side effects,
// dosage").

export type SeoTemplateText = {
  title: string;
  description: string;
  keywords: string[];
};

type ByLocale = { fa: SeoTemplateText; en: SeoTemplateText; ar?: SeoTemplateText };

export const seoNodeDefaults: Record<string, ByLocale> = {
  "/dr/[slug]": {
    fa: {
      title: "دکتر {name}[، {speciality}][ در {city}] | نوبت‌دهی اینترنتی",
      description:
        "نوبت‌دهی اینترنتی دکتر {name}[، {speciality}][ در {city}].[ امتیاز {rating} از ۵ از {reviews} نظر بیماران.][ ویزیت از {price} تومان.] آدرس مطب، ساعات کاری و مشاوره‌ی آنلاین.",
      keywords: ["دکتر {name}", "[نوبت دکتر {name}]", "[{speciality} {city}]", "[بهترین {speciality} {city}]"],
    },
    en: {
      title: "Dr. {name}[, {speciality}][ in {city}] | Book online",
      description:
        "Book an appointment with Dr. {name}[, {speciality}][ in {city}].[ Rated {rating}/5 from {reviews} patient reviews.][ Visits from {price} toman.] Office address, hours and online consultation.",
      keywords: ["Dr. {name}", "[{speciality} {city}]", "[best {speciality} in {city}]"],
    },
    ar: {
      title: "د. {name}[، {speciality}][ في {city}] | حجز موعد",
      description:
        "احجز موعدًا مع د. {name}[، {speciality}][ في {city}].[ تقييم {rating} من 5 من {reviews} مراجعة.] العنوان وساعات العمل والاستشارة عبر الإنترنت.",
      keywords: ["د. {name}", "[{speciality} {city}]"],
    },
  },
  "/clinic/[slug]": {
    fa: {
      title: "{name}[ {city}] | آدرس، تلفن و نوبت‌دهی",
      description:
        "{name}[ در {district}][، {city}]: آدرس روی نقشه،[ تلفن {phone}،][ ساعات کاری {hours}،] پزشکان و نوبت‌دهی آنلاین.[ امتیاز {rating} از ۵.][ {summary}]",
      keywords: ["{name}", "[کلینیک {city}]", "[آدرس {name}]", "[تلفن {name}]"],
    },
    en: {
      title: "{name}[ {city}] | Address, phone and booking",
      description:
        "{name}[ in {district}][, {city}]: address on the map,[ phone {phone},][ hours {hours},] doctors and online booking.[ Rated {rating}/5.][ {summary}]",
      keywords: ["{name}", "[clinic {city}]"],
    },
  },
  "/hospital/[slug]": {
    fa: {
      title: "بیمارستان {name}[ {city}] | آدرس، تلفن و پزشکان",
      description:
        "بیمارستان {name}[ در {city}]: آدرس روی نقشه،[ تلفن {phone}،] بخش‌ها، پزشکان و نوبت‌دهی آنلاین.[ امتیاز {rating} از ۵.][ {summary}]",
      keywords: ["بیمارستان {name}", "[بیمارستان {city}]", "[آدرس بیمارستان {name}]"],
    },
    en: {
      title: "{name} Hospital[ {city}] | Address, phone and doctors",
      description:
        "{name} Hospital[ in {city}]: address on the map,[ phone {phone},] departments, doctors and online booking.[ Rated {rating}/5.][ {summary}]",
      keywords: ["{name} hospital", "[hospital {city}]"],
    },
  },
  "/paraClinic/[slug]": {
    fa: {
      title: "{name}[ {city}] | آزمایش‌ها، قیمت و جواب آنلاین",
      description:
        "{name}[ در {city}]: فهرست و قیمت آزمایش‌ها، نمونه‌گیری، دریافت جواب آنلاین و آدرس.[ تلفن {phone}.][ ساعات کاری {hours}.][ {summary}]",
      keywords: ["{name}", "[آزمایشگاه {city}]", "[قیمت آزمایش {name}]"],
    },
    en: {
      title: "{name}[ {city}] | Tests, prices and online results",
      description:
        "{name}[ in {city}]: tests and prices, sampling, online results and address.[ Phone {phone}.][ Hours {hours}.][ {summary}]",
      keywords: ["{name}", "[lab {city}]"],
    },
  },
  "/pharmacy/[slug]": {
    fa: {
      title: "داروخانه {name}[ {city}] | سفارش آنلاین دارو",
      description:
        "سفارش آنلاین دارو و محصولات بهداشتی از داروخانه {name}[ در {city}] با ارسال به آدرس شما.[ ساعات کاری {hours}.][ تلفن {phone}.][ {summary}]",
      keywords: ["داروخانه {name}", "[داروخانه {city}]", "[داروخانه آنلاین {city}]"],
    },
    en: {
      title: "{name} Pharmacy[ {city}] | Order medicine online",
      description:
        "Order medicine and health products online from {name} Pharmacy[ in {city}], delivered to your door.[ Hours {hours}.][ Phone {phone}.][ {summary}]",
      keywords: ["{name} pharmacy", "[pharmacy {city}]"],
    },
  },
  "/insurance/[slug]": {
    fa: {
      title: "بیمه {name} | طرح‌ها، پوشش‌ها و مراکز طرف قرارداد",
      description: "بیمه {name}: طرح‌ها و پوشش‌ها، پزشکان و مراکز طرف قرارداد و نحوه‌ی استفاده.[ {summary}]",
      keywords: ["بیمه {name}", "[مراکز طرف قرارداد {name}]"],
    },
    en: {
      title: "{name} insurance | Plans, coverage and network",
      description: "{name} insurance: plans and coverage, contracted doctors and centres, and how to use it.[ {summary}]",
      keywords: ["{name} insurance"],
    },
  },
  "/drug/[slug]": {
    fa: {
      title: "{name}[ ({alternateName})] | موارد مصرف، عوارض و دوز",
      description:
        "[{summary} ]اطلاعات داروی {name}:[ ماده‌ی مؤثر {ingredient}،][ شکل دارویی {form}،] موارد مصرف، عوارض جانبی، دوز مصرف، تداخلات و هشدارها.",
      keywords: ["{name}", "[{alternateName}]", "[عوارض {name}]", "[موارد مصرف {name}]"],
    },
    en: {
      title: "{name}[ ({alternateName})] | Uses, side effects and dosage",
      description:
        "[{summary} ]{name}:[ active ingredient {ingredient},][ form {form},] uses, side effects, dosage, interactions and warnings.",
      keywords: ["{name}", "[{name} side effects]", "[{name} uses]"],
    },
  },
  "/disease/[slug]": {
    fa: {
      title: "{name} | علائم، علت و درمان",
      description: "[{summary} ]{name} چیست؟ علائم، علت‌ها، تشخیص و روش‌های درمان، و زمانی که باید به پزشک مراجعه کرد.",
      keywords: ["{name}", "[علائم {name}]", "[درمان {name}]"],
    },
    en: {
      title: "{name} | Symptoms, causes and treatment",
      description: "[{summary} ]What is {name}? Symptoms, causes, diagnosis and treatment, and when to see a doctor.",
      keywords: ["{name}", "[{name} symptoms]", "[{name} treatment]"],
    },
  },
  "/symptom/[slug]": {
    fa: {
      title: "{name} | علت‌ها و زمان مراجعه به پزشک",
      description: "[{summary} ]علت‌های شایع {name}، بیماری‌های مرتبط و زمانی که باید به پزشک مراجعه کرد.",
      keywords: ["{name}", "[علت {name}]"],
    },
    en: {
      title: "{name} | Causes and when to see a doctor",
      description: "[{summary} ]Common causes of {name}, related conditions and when to see a doctor.",
      keywords: ["{name}", "[{name} causes]"],
    },
  },
  "/speciality/[slug]": {
    fa: {
      title: "بهترین پزشکان {name}[ | {count} پزشک] – نوبت‌دهی اینترنتی",
      description:
        "نوبت‌دهی اینترنتی[ از {count}] پزشک {name} با امتیاز و نظرات بیماران، آدرس مطب و مشاوره‌ی آنلاین.[ {summary}]",
      keywords: ["{name}", "[پزشک {name}]", "[بهترین پزشک {name}]", "[نوبت {name}]"],
    },
    en: {
      title: "Best {name} doctors[ | {count} doctors] – Book online",
      description:
        "Book online with[ {count}] {name} doctors, with ratings and patient reviews, office addresses and online consultation.[ {summary}]",
      keywords: ["{name}", "[{name} doctor]", "[best {name} doctor]"],
    },
  },
  "/service/[slug]": {
    fa: {
      title: "{name}[ – {provider}] | قیمت و نوبت",
      description: "{name}[ توسط {provider}][ با قیمت {price} تومان]؛ مراحل، نتایج و رزرو آنلاین.[ {summary}]",
      keywords: ["{name}", "[قیمت {name}]"],
    },
    en: {
      title: "{name}[ – {provider}] | Price and booking",
      description: "{name}[ by {provider}][ from {price} toman]: steps, results and online booking.[ {summary}]",
      keywords: ["{name}", "[{name} price]"],
    },
  },
  "/servicePackage/[slug]": {
    fa: {
      title: "{name}[ – {provider}] | قیمت و رزرو",
      description: "بسته‌ی {name}[ از {provider}][ با قیمت {price} تومان] و خدماتی که شامل می‌شود.[ {summary}]",
      keywords: ["{name}"],
    },
    en: {
      title: "{name}[ – {provider}] | Price and booking",
      description: "The {name} package[ by {provider}][ from {price} toman] and the services it includes.[ {summary}]",
      keywords: ["{name}"],
    },
  },
  "/product/[slug]": {
    fa: {
      title: "{name} | قیمت و خرید آنلاین",
      description: "خرید آنلاین {name}[ با قیمت {price} تومان] از داروخانه‌های معتبر با ارسال به آدرس شما.[ {summary}]",
      keywords: ["{name}", "[قیمت {name}]", "[خرید {name}]"],
    },
    en: {
      title: "{name} | Price and buy online",
      description: "Buy {name} online[ from {price} toman] from licensed pharmacies, delivered to your door.[ {summary}]",
      keywords: ["{name}", "[{name} price]"],
    },
  },
  "/productPackage/[slug]": {
    fa: {
      title: "{name}[ – {provider}] | قیمت و خرید",
      description: "بسته‌ی {name}[ از {provider}][ با قیمت {price} تومان] و محصولاتی که شامل می‌شود.[ {summary}]",
      keywords: ["{name}"],
    },
    en: {
      title: "{name}[ – {provider}] | Price and buy",
      description: "The {name} pack[ from {provider}][ at {price} toman] and the products it includes.[ {summary}]",
      keywords: ["{name}"],
    },
  },
  "/mag/[blogSlug]": {
    fa: {
      title: "{name}",
      description: "[{summary}]",
      keywords: ["[{category}]"],
    },
    en: {
      title: "{name}",
      description: "[{summary}]",
      keywords: ["[{category}]"],
    },
  },
};

// listing pages: {count} is how many public records the page lists
export const seoListDefaults: Record<string, ByLocale> = {
  "/": {
    fa: {
      title: "نوبت‌دهی اینترنتی پزشک، مشاوره‌ی آنلاین و داروخانه",
      description:
        "نوبت‌دهی اینترنتی از پزشکان، کلینیک‌ها و بیمارستان‌ها، مشاوره‌ی آنلاین، سفارش دارو و آزمایش در خانه؛ همه در یک جا.",
      keywords: ["نوبت دهی اینترنتی", "نوبت دکتر", "مشاوره آنلاین پزشکی", "داروخانه آنلاین"],
    },
    en: {
      title: "Book doctors online, telemedicine and pharmacy",
      description: "Book doctors, clinics and hospitals online, consult online, order medicine and home lab tests – all in one place.",
      keywords: ["book a doctor", "online consultation", "online pharmacy"],
    },
  },
  "/doctors": {
    fa: {
      title: "نوبت‌دهی اینترنتی پزشکان[ | {count} پزشک]",
      description: "جستجو و نوبت‌دهی اینترنتی[ از {count}] پزشک بر اساس تخصص، شهر، بیمه و نظرات بیماران.",
      keywords: ["نوبت دکتر", "پزشک", "نوبت دهی اینترنتی"],
    },
    en: {
      title: "Book doctors online[ | {count} doctors]",
      description: "Find and book[ {count}] doctors by specialty, city, insurance and patient reviews.",
      keywords: ["book a doctor", "find a doctor"],
    },
  },
  "/speciality": {
    fa: {
      title: "تخصص‌های پزشکی | پزشک مناسب خود را پیدا کنید",
      description: "همه‌ی تخصص‌های پزشکی[ ({count} تخصص)] و پزشکان هر تخصص با نوبت‌دهی اینترنتی.",
      keywords: ["تخصص پزشکی", "لیست تخصص ها"],
    },
    en: {
      title: "Medical specialties | Find the right doctor",
      description: "All medical specialties[ ({count})] and their doctors, with online booking.",
      keywords: ["medical specialties"],
    },
  },
  "/clinic": {
    fa: {
      title: "کلینیک‌ها[ | {count} کلینیک] – آدرس و نوبت‌دهی",
      description: "فهرست[ {count}] کلینیک با آدرس روی نقشه، پزشکان، بیمه‌های طرف قرارداد و نوبت‌دهی اینترنتی.",
      keywords: ["کلینیک", "کلینیک نزدیک من"],
    },
    en: {
      title: "Clinics[ | {count} clinics] – Address and booking",
      description: "[{count} ]clinics with map address, doctors, accepted insurance and online booking.",
      keywords: ["clinic", "clinic near me"],
    },
  },
  "/hospital": {
    fa: {
      title: "بیمارستان‌ها[ | {count} بیمارستان] – آدرس و پزشکان",
      description: "فهرست[ {count}] بیمارستان با آدرس، بخش‌ها، پزشکان و نوبت‌دهی اینترنتی.",
      keywords: ["بیمارستان", "بیمارستان نزدیک من"],
    },
    en: {
      title: "Hospitals[ | {count} hospitals] – Address and doctors",
      description: "[{count} ]hospitals with address, departments, doctors and online booking.",
      keywords: ["hospital"],
    },
  },
  "/paraClinic": {
    fa: {
      title: "آزمایشگاه‌ها و مراکز تصویربرداری[ | {count} مرکز]",
      description: "آزمایشگاه‌ها و مراکز تصویربرداری با قیمت آزمایش‌ها، نمونه‌گیری در خانه و جواب آنلاین.",
      keywords: ["آزمایشگاه", "آزمایش در منزل", "سونوگرافی"],
    },
    en: {
      title: "Labs and imaging centres[ | {count}]",
      description: "Labs and imaging centres with test prices, home sampling and online results.",
      keywords: ["lab test", "home sampling"],
    },
  },
  "/insurance": {
    fa: {
      title: "بیمه‌های درمانی | طرح‌ها و مراکز طرف قرارداد",
      description: "مقایسه‌ی بیمه‌های درمانی[ ({count} بیمه)]، طرح‌ها، پوشش‌ها و پزشکان و مراکز طرف قرارداد.",
      keywords: ["بیمه درمانی", "بیمه تکمیلی"],
    },
    en: {
      title: "Health insurance | Plans and networks",
      description: "Compare[ {count}] health insurers, their plans, coverage and contracted providers.",
      keywords: ["health insurance"],
    },
  },
  "/drug": {
    fa: {
      title: "دارونامه | موارد مصرف، عوارض و دوز داروها",
      description: "اطلاعات[ {count}] دارو: موارد مصرف، عوارض جانبی، دوز، تداخلات و هشدارها.",
      keywords: ["دارونامه", "عوارض دارو"],
    },
    en: {
      title: "Drug guide | Uses, side effects and dosage",
      description: "Information on[ {count}] medicines: uses, side effects, dosage, interactions and warnings.",
      keywords: ["drug guide"],
    },
  },
  "/disease": {
    fa: {
      title: "بیماری‌ها | علائم، علت و درمان",
      description: "راهنمای[ {count}] بیماری: علائم، علت‌ها، تشخیص و درمان.",
      keywords: ["بیماری ها", "علائم بیماری"],
    },
    en: {
      title: "Conditions | Symptoms, causes and treatment",
      description: "A guide to[ {count}] conditions: symptoms, causes, diagnosis and treatment.",
      keywords: ["diseases"],
    },
  },
  "/symptom": {
    fa: {
      title: "علائم بیماری | علت‌ها و زمان مراجعه به پزشک",
      description: "راهنمای[ {count}] علامت: علت‌های شایع و زمانی که باید به پزشک مراجعه کرد.",
      keywords: ["علائم بیماری"],
    },
    en: {
      title: "Symptoms | Causes and when to see a doctor",
      description: "A guide to[ {count}] symptoms: common causes and when to see a doctor.",
      keywords: ["symptoms"],
    },
  },
  "/product": {
    fa: {
      title: "خرید آنلاین دارو و محصولات بهداشتی",
      description: "خرید آنلاین[ {count}] محصول دارویی و بهداشتی از داروخانه‌های معتبر با ارسال به آدرس شما.",
      keywords: ["داروخانه آنلاین", "خرید دارو"],
    },
    en: {
      title: "Buy medicine and health products online",
      description: "Buy[ {count}] health products online from licensed pharmacies, delivered to your door.",
      keywords: ["online pharmacy"],
    },
  },
  "/service": {
    fa: {
      title: "خدمات درمانی | قیمت و نوبت",
      description: "خدمات درمانی و زیبایی[ ({count} خدمت)] با قیمت، مراحل و رزرو آنلاین.",
      keywords: ["خدمات درمانی"],
    },
    en: {
      title: "Medical services | Prices and booking",
      description: "Medical and cosmetic services[ ({count})] with prices, steps and online booking.",
      keywords: ["medical services"],
    },
  },
  "/test": {
    fa: {
      title: "آزمایش‌ها | قیمت و نمونه‌گیری در منزل",
      description: "فهرست[ {count}] آزمایش با قیمت آزمایشگاه‌ها، آمادگی قبل از آزمایش و جواب آنلاین.",
      keywords: ["قیمت آزمایش", "آزمایش در منزل"],
    },
    en: {
      title: "Lab tests | Prices and home sampling",
      description: "[{count} ]lab tests with lab prices, preparation and online results.",
      keywords: ["lab test price"],
    },
  },
  "/mag": {
    fa: {
      title: "مجله‌ی سلامت",
      description: "مقاله‌های سلامت و پزشکی[ ({count} مقاله)] به قلم پزشکان و مراکز درمانی.",
      keywords: ["مجله سلامت", "مقالات پزشکی"],
    },
    en: {
      title: "Health magazine",
      description: "Health and medical articles[ ({count})] written by doctors and care centres.",
      keywords: ["health articles"],
    },
  },
};
