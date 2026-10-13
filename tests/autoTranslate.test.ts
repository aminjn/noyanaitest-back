import {
  api,
  createDoctor,
  createUser,
  externalFetchStubs,
  startTestApp,
  stopTestApp,
} from "./helpers";

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import AppConfig from "../Models/AppConfig";
import User from "../Models/User";
import Speciality from "../Models/Speciality";
import ServiceCategory from "../Models/ServiceCategory";
import Insurance from "../Models/Insurance";
import Test from "../Models/Test";
import DoctorProfile from "../Models/DoctorProfile";
import DoctorInsurance from "../Models/DoctorInsurance";
import DoctorFaq from "../Models/DoctorFaq";
import Office from "../Models/Office";
import Clinic from "../Models/Clinic";
import ClinicDepartment from "../Models/ClinicDepatment";
import TranslationTask from "../Models/TranslationTask";
import { clearSiteLocalesCache } from "../Lib/siteLocales";
import { migrateGlobalDoctorFaqs } from "../Lib/migrateGlobalDoctorFaqs";
import {
  drainTranslationQueue,
  lastScan,
  pauseTranslationWorker,
  workerState,
  runTranslationBackfill,
  translationQueueStatus,
} from "../Services/autoTranslate";

// Automatic translation of DB content (Services/autoTranslate.ts) end to
// end, with a stub AI provider: no provider -> the queue fills and the admin
// sees the count; with one -> new records are translated into the enabled
// languages only, an admin's manual translation is kept, the backfill finds
// nothing left, and the en page of a doctor shows the translated catalogue
// names. Also: the doctor FAQ's public phones and the archived shared FAQs.

const STUB = "http://stub-ai.test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// the hooks enqueue without awaiting the write's caller
const settle = () => sleep(250);

const langCode: Record<string, string> = { English: "en", Arabic: "ar", German: "de" };
let aiCalls = 0;
externalFetchStubs.push(async (url, init) => {
  if (!url.startsWith(`${STUB}/v1/messages`)) return undefined;
  aiCalls++;
  const body = JSON.parse(String(init?.body || "{}"));
  const prompt: string = body.messages?.[0]?.content || "";
  const names = prompt.includes("person's name");
  const lang = (prompt.match(/(?:into|in) (English|Arabic|German)/) || [])[1] || "?";
  const texts: string[] = JSON.parse(prompt.slice(prompt.lastIndexOf("\n[") + 1));
  const out = texts.map((t) => `[${langCode[lang]}${names ? "-name" : ""}] ${t}`);
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(out) }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

const setAi = async (on: boolean) => {
  await AppConfig.findOneAndUpdate(
    { singleton: "SINGLETON" },
    {
      $set: {
        aiProvider: "anthropic",
        aiApiKey: on ? "stub-key" : "",
        aiBaseUrl: STUB,
        translationAiEnabled: on,
        translationAiModel: "stub-model",
        enabledLocales: ["fa", "en", "ar"],
        defaultLocale: "fa",
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
  clearSiteLocalesCache();
};

const waitScan = async () => {
  for (let i = 0; i < 100 && lastScan().running; i++) await sleep(50);
};

let admin: any;
const ids: Record<string, string> = {};

before(async () => {
  await startTestApp();
  admin = await createUser();
  await User.updateOne({ _id: admin._id }, { $set: { role: "admin" } });
  await setAi(false);
});
after(stopTestApp);

describe("automatic content translation", () => {
  test("without a provider: new records fill the queue, the admin sees the count", async () => {
    // through the admin API (the path NodesSelector's inline create uses)
    const sp = await api("POST", "/api/v1/auto/speciality", { user: admin._id, body: { name: "قلب و عروق", active: true } });
    assert.equal(sp.status, 200, JSON.stringify(sp.body));
    ids.speciality = sp.body.data.data._id;
    const ts = await api("POST", "/api/v1/auto/test", { user: admin._id, body: { name: "آزمایش قند خون", isActive: true } });
    assert.equal(ts.status, 200, JSON.stringify(ts.body));
    ids.test = ts.body.data.data._id;
    // and directly (an import / a panel)
    ids.service = String((await ServiceCategory.create({ title: "نوار قلب", isActive: true }))._id);
    ids.insurance = String((await Insurance.create({ name: "بیمه سلامت", active: true }))._id);
    await settle();

    const tasks = await TranslationTask.find({}).lean();
    for (const [model, id] of [
      ["Speciality", ids.speciality],
      ["Test", ids.test],
      ["ServiceCategory", ids.service],
      ["Insurance", ids.insurance],
    ])
      assert.ok(tasks.some((t) => t.model === model && String(t.doc) === id), `${model} queued`);

    const overview = await api("GET", "/api/v1/auto/_translations", { user: admin._id });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.data.machine, false);
    assert.deepEqual(overview.body.data.locales, ["en", "ar"]);
    assert.ok(overview.body.data.queue.pending >= 4);

    // the admin's button: scan + queue (works without a provider)
    const bulk = await api("POST", "/api/v1/auto/_translations/bulk", { user: admin._id });
    assert.equal(bulk.status, 202, JSON.stringify(bulk.body));
    await waitScan();
    const scan = lastScan();
    assert.ok(scan.records >= 4, `missing records ${scan.records}`);
    assert.equal(scan.missing.Speciality?.en, 1);
    assert.equal(scan.missing.Speciality?.ar, 1);
    assert.equal(scan.missing.Speciality?.de, undefined);

    // nothing is sent while no provider is set
    assert.equal(await drainTranslationQueue({ gapMs: 0 }), 0);
    assert.equal(aiCalls, 0);
  });

  test("with a provider: translated into the enabled languages; manual edits kept", async () => {
    await setAi(true);
    await drainTranslationQueue({ gapMs: 0 });
    const sp: any = await Speciality.findById(ids.speciality).lean();
    assert.equal(sp.translations.en.name, "[en] قلب و عروق");
    assert.equal(sp.translations.ar.name, "[ar] قلب و عروق");
    assert.equal(sp.translations.de, undefined, "a disabled language is not translated");
    const sc: any = await ServiceCategory.findById(ids.service).lean();
    assert.equal(sc.translations.en.title, "[en] نوار قلب");
    const ins: any = await Insurance.findById(ids.insurance).lean();
    assert.equal(ins.translations.ar.name, "[ar] بیمه سلامت");
    const t: any = await Test.findById(ids.test).lean();
    assert.equal(t.translations.en.name, "[en] آزمایش قند خون");
    assert.equal(await TranslationTask.countDocuments({}), 0);

    // the admin corrects the English by hand, then the Persian changes
    const manual = await api("POST", `/api/v1/auto/speciality/${ids.speciality}/_translations`, {
      user: admin._id,
      body: { locale: "en", values: { name: "Cardiology" } },
    });
    assert.equal(manual.status, 200);
    const edit = await api("POST", `/api/v1/auto/speciality/${ids.speciality}`, {
      user: admin._id,
      body: { name: "قلب و عروق بزرگسالان" },
    });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    await settle();
    assert.equal(await TranslationTask.countDocuments({ model: "Speciality" }), 1, "an edit is queued");
    await drainTranslationQueue({ gapMs: 0 });
    const after: any = await Speciality.findById(ids.speciality).lean();
    assert.equal(after.translations.en.name, "Cardiology", "a manual translation is never replaced");
    assert.equal(after.translations.ar.name, "[ar] قلب و عروق بزرگسالان", "a machine one follows the source");

    // person names are transliterated (their own prompt)
    const { doctor } = await createDoctor();
    await DoctorProfile.updateOne({ _id: doctor._id }, { $set: { firstName: "محمد", lastName: "رضایی" } });
    await settle();
    await drainTranslationQueue({ gapMs: 0 });
    const dr: any = await DoctorProfile.findById(doctor._id).lean();
    assert.equal(dr.translations.en.firstName, "[en-name] محمد");
    ids.doctor = String(doctor._id);
  });

  test("backfill: nothing left once translated; a failure is reported", async () => {
    await runTranslationBackfill({ reason: "test" });
    assert.equal(lastScan().records, 0, JSON.stringify(lastScan().missing));
    assert.equal((await translationQueueStatus()).queue.pending, 0);

    // the provider is overloaded: the record is not blamed, the queue waits
    await Speciality.create({ name: "پوست", active: true });
    await settle();
    const overloaded = (url: string) =>
      url.startsWith(`${STUB}/v1/messages`) ? new Response("overloaded", { status: 529 }) : undefined;
    externalFetchStubs.unshift(overloaded);
    await drainTranslationQueue({ gapMs: 0 });
    externalFetchStubs.shift();
    let task: any = await TranslationTask.findOne({ model: "Speciality" }).lean();
    assert.ok(task && task.state === "pending" && task.attempts === 0 && /529/.test(task.lastError || ""), JSON.stringify(task));
    assert.ok(workerState().backoffUntil, "the whole queue backs off");
    assert.equal(await drainTranslationQueue({ gapMs: 0 }), 0, "nothing is sent during the backoff");

    // a reply the record can't use: counted, and after the last attempt
    // listed as failed for the admin
    const garbage = (url: string) =>
      url.startsWith(`${STUB}/v1/messages`)
        ? new Response(JSON.stringify({ content: [{ type: "text", text: "sorry" }] }), { status: 200 })
        : undefined;
    externalFetchStubs.unshift(garbage);
    pauseTranslationWorker(false);
    await TranslationTask.updateMany({}, { $set: { nextAt: new Date(0), attempts: 4 } });
    await drainTranslationQueue({ gapMs: 0 });
    externalFetchStubs.shift();
    task = await TranslationTask.findOne({ model: "Speciality" }).lean();
    assert.equal(task?.state, "failed", JSON.stringify(task));
    const status = await translationQueueStatus();
    assert.equal(status.queue.failed, 1);
    assert.equal(status.failures[0].model, "Speciality");

    // the admin's button retries it
    const bulk = await api("POST", "/api/v1/auto/_translations/bulk", { user: admin._id });
    assert.equal(bulk.status, 202);
    await waitScan();
    await drainTranslationQueue({ gapMs: 0 });
    assert.equal(await TranslationTask.countDocuments({}), 0);
  });

  test("the en doctor page shows translated catalogue names and office phones", async () => {
    const { doctor, doctorUser } = await createDoctor();
    await DoctorProfile.updateOne(
      { _id: doctor._id },
      {
        $set: {
          slug: "dr-auto-translate",
          active: true,
          mainSpeciality: ids.speciality,
          specialities: [ids.speciality],
          serviceCategories: [ids.service],
          // the account's own mobile typed as the land line: never public
          landLine: (doctorUser as any).phone.replace(/^98/, "0"),
        },
      },
    );
    await DoctorInsurance.create({ doctor: doctor._id, insurance: ids.insurance });
    await Office.create({ doctor: doctor._id, name: "مطب مرکزی", address: "تهران، خیابان ولیعصر", tel: "021-88001122", active: true });
    await Office.create({ doctor: doctor._id, name: "مطب دوم", address: "کرج", tel: "02634001122", active: true, order: 1 });
    // a question once shared by every doctor page: archived, not shown
    await DoctorFaq.collection.insertOne({ question: "سوال همه", answer: "جواب", active: true, order: 0 });
    await DoctorFaq.create({ doctor: doctor._id, question: "سوال خودم", answer: "جواب خودم", active: true });
    await migrateGlobalDoctorFaqs();
    assert.equal(await DoctorFaq.countDocuments({ archived: true }), 1);
    await settle();
    await drainTranslationQueue({ gapMs: 0 });

    const en = await api("GET", "/api/v1/public/dr/dr-auto-translate", { headers: { "x-locale": "en" } });
    assert.equal(en.status, 200, JSON.stringify(en.body).slice(0, 300));
    const { doctor: page, faqs, autoFaq } = en.body.data;
    assert.equal(page.mainSpeciality.name, "Cardiology");
    assert.equal(autoFaq.facts.speciality.main.name, "Cardiology");
    assert.equal(autoFaq.facts.services.services[0].title, "[en] نوار قلب");
    assert.equal(autoFaq.facts.insurance.items[0].name, "[en] بیمه سلامت");
    // the page carries no number (2026-10, «نمایش شماره تماس»): the
    // reveal endpoint answers with the offices' lines, translated
    assert.equal(autoFaq.facts.phone, undefined);
    assert.equal(autoFaq.facts.booking.hasPhone, true);
    assert.equal(en.body.data.phoneReveal.count, 2);
    const reveal = await api("POST", `/api/v1/public/phone/doctor/${doctor._id}`, {
      headers: {
        "x-locale": "en",
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
      body: { ticket: en.body.data.phoneReveal.ticket, placement: "header" },
    });
    assert.equal(reveal.status, 200, JSON.stringify(reveal.body).slice(0, 300));
    assert.deepEqual(
      reveal.body.data.phones.map((p: any) => [p.name, p.phone]),
      [
        ["[en] مطب مرکزی", "02188001122"],
        ["[en] مطب دوم", "02634001122"],
      ],
    );
    assert.deepEqual(faqs.map((f: any) => f.question), ["[en] سوال خودم"]);

    const ar = await api("GET", "/api/v1/public/dr/dr-auto-translate", { headers: { "x-locale": "ar" } });
    assert.equal(ar.body.data.doctor.mainSpeciality.name, "[ar] قلب و عروق بزرگسالان");

    // the admin can no longer create a question with no doctor
    const create = await api("POST", "/api/v1/auto/doctorfaq", {
      user: admin._id,
      body: { question: "برای همه", answer: "x", active: true },
    });
    assert.notEqual(create.status, 200);
  });

  test("a centre's FAQ phones: its line and its departments', never the account's mobile", async () => {
    const owner = await createUser();
    const clinic = await Clinic.create({
      name: "کلینیک نمونه",
      slug: "clinic-auto-phones",
      active: true,
      user: owner._id,
      phone: (owner as any).phone,
    });
    await ClinicDepartment.create({ clinic: clinic._id, name: "بخش قلب", phone: "021 7700 1122", active: true });
    await ClinicDepartment.create({ clinic: clinic._id, name: "بخش پوست", phone: "۰۲۱۷۷۰۰۱۱۲۲", active: true });
    const res = await api("GET", "/api/v1/public/clinic/clinic-auto-phones");
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    assert.deepEqual(
      res.body.data.data.publicPhones.map((p: any) => [p.name, p.phone]),
      [["بخش قلب", "02177001122"]],
      "the owner's mobile is left out, a repeated number is listed once",
    );
  });
});
