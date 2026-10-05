import express from "express";
import * as authController from "../Controllers/authController";
import * as aclController from "../Controllers/aclController";
import * as c from "../Controllers/panelAiController";
import { audioUpload } from "../Controllers/visitController";
import { panelAiGate } from "../Lib/ai/panelAi";

// AI in every panel (2026-10), mounted at /api/v1/ai:
//   /ai/user/...   the patient's own dashboard (their AI limit, Pro)
//   /ai/admin/...  the super admin and staff
//   /ai/:name/...  a provider panel (doctor, clinic, hospital, pharmacy,
//                  paraClinic, insurance) - useAcl() runs first, so a
//                  secretary acts for her org with her own ACL
// panelAiGate checks the ACL and the provider, then the AI policy of the
// feature (Lib/ai/aiGate.ts checkAndConsumeAi), which counts the use. The copilot's tools check their
// own ACL action and module again (Lib/ai/copilot/engine.ts).
const router = express.Router({ mergeParams: true });

router.use(authController.protect);

// ---------------- patient ----------------
router.get("/user/status", c.selfStatus("user"));
router.post("/user/copilot", c.userCopilot);
router.get("/user/copilot/history", c.history("user"));
router.delete("/user/copilot/history", c.deleteHistory("user"));
router.post("/user/transcribe", audioUpload, c.transcribeAudio("user"));

// ---------------- super admin / staff ----------------
const staff = authController.restrictTo("admin", "notadmin");
router.get("/admin/status", staff, c.selfStatus("admin"));
router.post("/admin/copilot", staff, c.adminCopilot);
router.get("/admin/copilot/history", staff, c.history("admin"));
router.delete("/admin/copilot/history", staff, c.deleteHistory("admin"));
router.post("/admin/transcribe", staff, audioUpload, c.transcribeAudio("admin"));

// ---------------- provider panels ----------------
const org = aclController.useAcl();
router.get("/:name/status", org, c.orgStatus);
router.post("/:name/copilot", org, panelAiGate("assistant.copilot"), c.orgCopilot);
router.get("/:name/copilot/history", org, c.history());
router.delete("/:name/copilot/history", org, c.deleteHistory());
router.post("/:name/transcribe", org, audioUpload, panelAiGate("assistant.voice", { stt: true }), c.transcribeAudio());

// doctor: voice prescription (the writer itself), chat suggestions and the
// patient summary - clinical data, so the prescription and the summary are
// owner only, like the visit note (visitController)
router.post("/:name/rx/parse", org, panelAiGate("clinical.rx", { needs: "owner", doctorOnly: true }), c.parseRx);
router.post("/:name/chat/:chatId/suggest", org, panelAiGate("clinical.chatSuggest", { needs: "readChat", doctorOnly: true }), c.suggestChat);
router.post("/:name/patient/:nodeId/summary", org, panelAiGate("clinical.patientSummary", { needs: "owner", doctorOnly: true }), c.summarizePatient);

// CRM texts and insight, call analysis (every org panel)
router.post("/:name/crm/template", org, panelAiGate("crm.template", { needs: "manageCrm" }), c.crmTemplate);
router.post("/:name/crm/plan", org, panelAiGate("crm.plan", { needs: "readCrm" }), c.crmPlan);
router.post("/:name/crm/contact/:contactId/insight", org, panelAiGate("crm.contactInsight", { needs: "readCrm" }), c.crmContactInsight);
router.post("/:name/call/analyze", org, audioUpload, panelAiGate("crm.callAnalysis", { needs: "readCrm" }), c.analyzeCallAudio);

export default router;
