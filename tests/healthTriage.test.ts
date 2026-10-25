import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { fallbackAssessment, nextStep, Step } from "../Lib/triage/interviewFlow";
import { PatientContext } from "../Lib/triage/patientContext";
import { chooseSpeciality } from "../Lib/triageSpeciality";

// The health chat's interview (2026-10, owner report: the small model asked
// «where is the pain?» right after «my buttock hurts», diagnosed before the
// answers and sent back pain to gynaecology). These replay conversations
// through the real state machine: the chat history is the state, as in
// Controllers/botController.ts.

type Msg = { role: string; content: string; meta?: Record<string, unknown> };

// the patient says each line in turn; the site answers as the controller would
const converse = (lines: string[], patient: PatientContext = {}) => {
  const history: Msg[] = [];
  const steps: Step[] = [];
  for (const line of lines) {
    const step = nextStep(history as never, line, patient);
    steps.push(step);
    history.push({ role: "user", content: line });
    if (step.kind === "ask") history.push({ role: "assistant", content: step.text, meta: { options: step.options, interview: step.interview } });
    else history.push({ role: "assistant", content: step.kind === "emergency" ? step.text : "assessment", meta: {} });
  }
  return steps;
};
const asked = (s: Step) => (s.kind === "ask" ? s.interview.q : s.kind);
const last = (steps: Step[]) => steps[steps.length - 1];

describe("health chat interview", () => {
  test("too little information: asks, never assesses after the complaint alone", () => {
    const [first] = converse(["باسنم درد میکنه"]);
    assert.equal(first.kind, "ask");
    // it does not ask where it hurts with head / neck answers
    assert.ok(first.kind === "ask" && !first.options.some((o) => /سر|گردن|شانه/.test(o) && !/باسن/.test(o)));
  });

  test("mild complaint with a full history: assessment only after every answer, no hurry", () => {
    const steps = converse(["کمرم درد میکنه", "۱۲ تا ۶۵ سال", "نه، فقط در کمر است", "بعد از بلند کردن بار یا حرکت ناگهانی", "با نشستن یا خم شدن", "هیچ‌کدام", "متوسط، اذیتم می‌کند"]);
    assert.deepEqual(steps.slice(0, -1).map((s) => s.kind), Array(6).fill("ask"));
    const end = last(steps);
    assert.equal(end.kind, "assess");
    assert.ok(end.kind === "assess" && end.urgency === "routine");
  });

  test("emergency sign: the interview stops at once with the 115 advice", () => {
    const steps = converse(["قفسه سینه‌ام درد میکنه", "۱۲ تا ۶۵ سال", "فشار یا سنگینی روی سینه"]);
    assert.equal(last(steps).kind, "emergency");
    assert.ok(last(steps).kind === "emergency" && /۱۱۵/.test((last(steps) as { text: string }).text));
  });

  test("warning sign in free text, even mid-interview", () => {
    const steps = converse(["سرم درد میکنه", "دیروز بیهوش شدم"]);
    assert.equal(last(steps).kind, "emergency");
    assert.equal(converse(["دیگه نمیخوام زنده باشم، به خودکشی فکر میکنم"])[0].kind, "emergency");
  });

  test("an emergency answer typed to another question still counts", () => {
    const steps = converse(["کمرم درد میکنه", "۱۲ تا ۶۵ سال", "نه، فقط در کمر است", "بی‌اختیاری ادرار یا مدفوع"]);
    assert.equal(last(steps).kind, "emergency");
  });

  test("unclear answer: asked once more, then unknown, and an unclear warning sign is not «no hurry»", () => {
    const steps = converse(["کمرم درد میکنه", "۱۲ تا ۶۵ سال", "نه، فقط در کمر است", "کم‌کم و بدون دلیل", "فرقی ندارد", "نمیدونم"]);
    const again = last(steps);
    assert.ok(again.kind === "ask" && again.interview.q === "with" && again.interview.clarify);
    const done = converse(["کمرم درد میکنه", "۱۲ تا ۶۵ سال", "نه، فقط در کمر است", "کم‌کم و بدون دلیل", "فرقی ندارد", "نمیدونم", "نمیدونم", "خفیف، کارهایم را می‌کنم"]);
    const end = last(done);
    assert.ok(end.kind === "assess" && end.urgency === "soon" && end.unclear.length === 1);
    assert.ok(end.kind === "assess" && end.answers.some((x) => x.a === "نامشخص"));
  });

  test("the next question follows the answer (blood → how much; leg pain → weakness)", () => {
    const anal = converse(["باسنم درد میکنه", "۱۲ تا ۶۵ سال", "داخل یا لبه‌ی مقعد", "خون روشن روی دستمال یا مدفوع"]);
    assert.equal(asked(last(anal)), "blood");
    const noBlood = converse(["باسنم درد میکنه", "۱۲ تا ۶۵ سال", "داخل یا لبه‌ی مقعد", "یبوست دارم"]);
    assert.equal(asked(last(noBlood)), "with");
    const back = converse(["کمرم درد میکنه", "۱۲ تا ۶۵ سال", "بله، تا زیر زانو و کف پا"]);
    assert.equal(asked(last(back)), "legs");
    // a man is never asked about pregnancy
    const belly = converse(["شکمم درد میکنه", "۱۲ تا ۶۵ سال", "پایین سمت راست", "مرد"]);
    assert.notEqual(asked(last(belly)), "pregnant");
    const woman = converse(["شکمم درد میکنه", "۱۲ تا ۶۵ سال", "پایین سمت راست", "زن"]);
    assert.equal(asked(last(woman)), "pregnant");
  });

  test("information already given is not asked again", () => {
    // the age and the side of the head are in the first message
    const steps = converse(["۳۰ سالمه و سمت چپ سرم یک طرف سر درد میکنه"]);
    const first = steps[0];
    assert.ok(first.kind === "ask" && first.interview.q !== "age" && first.interview.q !== "where");
    const all = converse(["۳۰ سالمه سردرد یک طرف سر دارم", "کم‌کم", "تهوع یا حساسیت به نور", "چند بار در ماه"]);
    const qs = all.filter((s) => s.kind === "ask").map(asked);
    assert.equal(new Set(qs).size, qs.length);
    assert.ok(!qs.includes("where") && !qs.includes("age"));
    assert.equal(last(all).kind, "assess");
  });

  test("the complaint changes mid-conversation: the new area's interview starts", () => {
    const steps = converse(["سرم درد میکنه", "۱۲ تا ۶۵ سال", "راستش بیشتر دندانم درد میکنه"]);
    const now = last(steps);
    assert.ok(now.kind === "ask" && now.interview.id === "teeth" && now.interview.start);
  });

  test("a question about a condition goes to the model, not an interview", () => {
    assert.equal(converse(["دیابت چیه؟"])[0].kind, "model");
    assert.equal(converse(["what is a migraine"])[0].kind, "model");
  });

  test("a baby with a fever is an emergency; a possible pregnancy with belly pain is seen soon", () => {
    assert.equal(last(converse(["بچه‌ام تب داره", "زیر ۳ ماه"])).kind, "emergency");
    const preg = converse(["شکمم درد میکنه", "۱۲ تا ۶۵ سال", "پایین سمت چپ", "زن", "بله", "هیچ‌کدام", "ارتباطی ندارد", "چند روز", "متوسط، اذیتم می‌کند"]);
    const end = last(preg);
    assert.ok(end.kind === "assess" && end.urgency === "soon");
  });

  test("the progress counts the questions this patient gets", () => {
    const steps = converse(["کمرم درد میکنه", "۱۲ تا ۶۵ سال", "بله، تا زیر زانو و کف پا"]);
    const s = last(steps);
    assert.ok(s.kind === "ask" && s.interview.n === 3 && s.interview.total === 7);
  });
});

describe("what the site already knows (Shahkar identity)", () => {
  const ali: PatientContext = { name: "علی", age: 34, sex: "male" };

  test("the name opens the interview; age and sex are not asked", () => {
    const [first] = converse(["شکمم درد میکنه"], ali);
    assert.ok(first.kind === "ask" && first.text.startsWith("علی عزیز") && first.interview.q === "where");
    const steps = converse(["شکمم درد میکنه", "پایین سمت راست"], ali);
    const qs = steps.filter((s) => s.kind === "ask").map(asked);
    assert.ok(!qs.includes("age") && !qs.includes("sex") && !qs.includes("pregnant"));
  });

  test("a woman of childbearing age is asked about pregnancy without being asked her sex", () => {
    const steps = converse(["شکمم درد میکنه", "پایین سمت چپ"], { name: "مریم", age: 29, sex: "female" });
    assert.equal(asked(last(steps)), "pregnant");
  });

  test("an option the first message already says is not asked", () => {
    const [first] = converse(["سرفه‌ی خشک و گلودرد دارم"], ali);
    assert.ok(first.kind === "ask" && first.interview.q !== "what");
  });

  test("a complaint about someone else asks their age", () => {
    const [first] = converse(["بچه‌ام تب داره"], ali);
    assert.ok(first.kind === "ask" && first.interview.q === "age");
  });

  test("the progress counts only what is asked", () => {
    const [first] = converse(["کمرم درد میکنه"], ali);
    assert.ok(first.kind === "ask" && first.interview.n === 1 && first.interview.total === 5);
  });

  test("the site's own assessment when the model does not answer: by name, how soon, warning signs", () => {
    const steps = converse(["کمرم درد میکنه", "نه، فقط در کمر است", "کم‌کم و بدون دلیل", "با نشستن یا خم شدن", "هیچ‌کدام", "متوسط، اذیتم می‌کند"], ali);
    const end = last(steps);
    assert.equal(end.kind, "assess");
    if (end.kind !== "assess") return;
    const text = fallbackAssessment(end, ali.name);
    assert.ok(text.startsWith("علی عزیز") && /۱۱۵/.test(text) && /معاینه/.test(text));
    assert.ok(end.answers.some((x) => x.q === "سن بیمار چقدر است؟" && x.a === "۱۲ تا ۶۵ سال"));
  });
});

describe("the suggested specialist", () => {
  const site = ["پزشک عمومی", "زنان و زایمان", "ارتوپدی", "جراحی کولورکتال", "جراحی عمومی", "اورولوژی", "کودکان", "گوارش و کبد", "مغز و اعصاب"].map((name, i) => ({
    _id: `s${i}`,
    name,
  }));
  const named = (name: string) => site.find((s) => s.name === name);
  const pick = (picked: string | undefined, patientText: string) =>
    chooseSpeciality({ picked: picked ? named(picked) : undefined, patientText, fromDiseases: [], specialities: site })?.name;

  test("back or buttock pain never goes to gynaecology", () => {
    assert.equal(pick("زنان و زایمان", "کمرم درد میکنه"), "ارتوپدی");
    assert.equal(pick("زنان و زایمان", "باسنم درد میکنه"), "جراحی کولورکتال");
  });
  test("a women's-health complaint may", () => {
    assert.equal(pick("زنان و زایمان", "شکمم درد میکنه\nاحتمال دارد باردار باشید؟ بله"), "زنان و زایمان");
  });
  test("a fitting pick stands; kidney pain with urinary symptoms is urology", () => {
    assert.equal(pick("مغز و اعصاب", "سرم درد میکنه"), "مغز و اعصاب");
    assert.equal(pick("اورولوژی", "کمرم درد میکنه و ادرارم میسوزه"), "اورولوژی");
  });
  test("a child's medical complaint goes to the paediatrician", () => {
    assert.equal(pick("پزشک عمومی", "تب دارم\nسن بیمار چقدر است؟ ۲ تا ۱۲ سال"), "کودکان");
    // not a surgical one
    assert.equal(pick("جراحی کولورکتال", "باسنم درد میکنه\nسن بیمار چقدر است؟ ۲ تا ۱۲ سال"), "جراحی کولورکتال");
  });
  test("only specialities the site has: nothing invented", () => {
    const out = chooseSpeciality({ picked: undefined, patientText: "دندانم درد میکنه", fromDiseases: [], specialities: site });
    assert.ok(!out || site.some((s) => s._id === out._id));
  });
});
