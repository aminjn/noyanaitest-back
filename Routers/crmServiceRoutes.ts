import express, { RequestHandler } from "express";
import { OwnerOf } from "../Controllers/businessController";
import { makeCrmServiceController } from "../Controllers/crmServiceController";
import { makeCrmWorkController } from "../Controllers/crmWorkController";
import { onlyFor } from "../Lib/business/crmService/profiles";

// The CRM's engagement and service API (2026-10, docs/nexxa-crm-
// engagement-parity.md), mounted inside /<panel>/crm (Routers/crmRoutes.ts):
//   read  (readCrm)       - the team's own work: reading articles, taking a
//                           quiz, answering a ticket, ticking a task or a
//                           checklist item, logging hours
//   write (manageCrm)     - setting things up: the club, rewards, sequences,
//                           articles, quizzes, boards, workflows, returns
//   send  (sendCampaigns) - switching on what spends SMS money (a sequence,
//                           a workflow)
export const crmServiceRouter = ({ ownerOf, read, write, send }: { ownerOf: OwnerOf; read: RequestHandler[]; write: RequestHandler[]; send: RequestHandler[] }) => {
  const s = makeCrmServiceController(ownerOf);
  const w = makeCrmWorkController(ownerOf);
  const router = express.Router({ mergeParams: true });

  router.get("/service/mine", ...read, s.getMine);
  // the profile's starter set (sequences, checklists, workflows), once
  router.post("/service/seed", ...write, s.seed);

  // parts some profiles don't have (an insurer: no club, no returns)
  router.use("/club", onlyFor(ownerOf, "club"));
  router.use("/returns", onlyFor(ownerOf, "returns"));
  router.use(["/checklists", "/checklist-items"], onlyFor(ownerOf, "checklists"));

  // club
  router.get("/club", ...read, s.getClub);
  router.put("/club/settings", ...write, s.saveClubSettings);
  router.post("/club/rewards", ...write, s.saveReward);
  router.patch("/club/rewards/:rewardId", ...write, s.saveReward);
  router.delete("/club/rewards/:rewardId", ...write, s.deleteReward);
  router.get("/club/members", ...read, s.getMembers);
  router.get("/club/members/:contactId", ...read, s.getMember);
  router.post("/club/members/:contactId/redeem", ...write, s.redeemForMember);
  router.post("/club/members/:contactId/tier-code", ...write, s.tierCode);
  router.post("/club/members/:contactId/adjust", ...write, s.adjust);
  router.delete("/club/adjustments/:adjustmentId", ...write, s.deleteAdjustment);
  router.get("/club/redemptions", ...read, s.getRedemptions);
  router.post("/club/redemptions/apply", ...write, s.applyRedemption);
  router.post("/club/redemptions/:redemptionId/unapply", ...write, s.unapplyRedemption);
  router.post("/club/redemptions/:redemptionId/cancel", ...write, s.cancelRedemption);

  // sequences
  router.get("/sequences", ...read, s.getSequences);
  router.post("/sequences", ...write, s.createSequence);
  router.get("/sequences/:sequenceId", ...read, s.getSequence);
  router.patch("/sequences/:sequenceId", ...write, s.updateSequence);
  router.post("/sequences/:sequenceId/toggle", ...send, s.toggleSequence);
  router.delete("/sequences/:sequenceId", ...write, s.deleteSequence);
  router.post("/sequences/:sequenceId/enroll", ...write, s.enroll);
  router.post("/enrollments/:enrollmentId/stop", ...write, s.stopEnrollment);

  // knowledge
  router.get("/kb/categories", ...read, s.getKbCategories);
  router.post("/kb/categories", ...write, s.createKbCategory);
  router.delete("/kb/categories/:categoryId", ...write, s.deleteKbCategory);
  router.get("/kb/articles", ...read, s.getArticles(false));
  router.get("/kb/manage/articles", ...write, s.getArticles(true));
  router.get("/kb/articles/:articleId", ...read, s.getArticle(false));
  router.get("/kb/manage/articles/:articleId", ...write, s.getArticle(true));
  router.post("/kb/articles", ...write, s.saveArticle);
  router.patch("/kb/articles/:articleId", ...write, s.saveArticle);
  router.delete("/kb/articles/:articleId", ...write, s.deleteArticle);

  // quizzes: taking (read) and managing (write)
  router.get("/quizzes/mine", ...read, s.getMyQuizzes);
  router.get("/quizzes/:quizId/take", ...read, s.getQuizToTake);
  router.post("/quizzes/:quizId/attempt", ...read, s.submitAttempt);
  router.get("/quiz-attempts/:attemptId/certificate", ...read, s.getCertificate(false));
  router.get("/quiz-attempts/:attemptId/certificate/manage", ...write, s.getCertificate(true));
  router.get("/quizzes", ...write, s.getQuizzes);
  router.post("/quizzes", ...write, s.saveQuiz);
  router.get("/quizzes/:quizId", ...write, s.getQuiz);
  router.patch("/quizzes/:quizId", ...write, s.saveQuiz);
  router.post("/quizzes/:quizId/toggle", ...write, s.toggleQuiz);
  router.delete("/quizzes/:quizId", ...write, s.deleteQuiz);
  router.post("/quizzes/:quizId/assign", ...write, s.assignQuiz);
  router.delete("/quiz-assignments/:assignmentId", ...write, s.unassignQuiz);

  // workflows and their runs (an approval step waits in the panel's
  // «کارتابل», Routers/kartablRoutes.ts)
  router.get("/flows", ...read, s.getFlows);
  router.post("/flows", ...write, s.saveFlow);
  router.get("/flows/:flowId", ...read, s.getFlow);
  router.patch("/flows/:flowId", ...write, s.saveFlow);
  router.post("/flows/:flowId/toggle", ...send, s.toggleFlow);
  router.post("/flows/:flowId/run", ...send, s.runFlow);
  router.delete("/flows/:flowId", ...write, s.deleteFlow);
  router.get("/flow-runs", ...read, s.getRuns);
  router.get("/flow-runs/:runId", ...read, s.getRun);
  router.post("/flow-runs/:runId/cancel", ...write, s.cancelRun);

  // returns
  router.get("/returns", ...read, s.getReturns);
  router.get("/returns/lookups", ...read, s.getReturnLookups);
  router.post("/returns", ...write, s.createReturn);
  router.post("/returns/:returnId/process", ...write, s.processReturn);
  router.post("/returns/:returnId/void", ...write, s.voidReturn);
  router.post("/returns/:returnId/cancel", ...write, s.cancelReturn);

  // tickets
  router.get("/tickets", ...read, w.getTickets);
  router.post("/tickets", ...write, w.createTicket);
  router.get("/tickets/:ticketId", ...read, w.getTicket);
  router.post("/tickets/:ticketId/reply", ...read, w.replyTicket);
  router.patch("/tickets/:ticketId", ...read, w.updateTicket);
  router.delete("/tickets/:ticketId", ...write, w.deleteTicket);

  // boards, tasks and hours
  router.get("/projects", ...read, w.getProjects);
  router.post("/projects", ...write, w.saveProject);
  router.get("/projects/:projectId", ...read, w.getProject);
  router.patch("/projects/:projectId", ...write, w.saveProject);
  router.delete("/projects/:projectId", ...write, w.deleteProject);
  router.post("/projects/:projectId/tasks", ...read, w.createTask);
  router.get("/tasks/mine", ...read, w.getMyTasks);
  router.patch("/tasks/:taskId", ...read, w.updateTask);
  router.post("/tasks/:taskId/toggle", ...read, w.toggleTask);
  router.delete("/tasks/:taskId", ...write, w.deleteTask);
  router.get("/tasks/:taskId/time", ...read, w.getTaskTime);
  router.post("/tasks/:taskId/time", ...read, w.logTime);
  router.patch("/time/:logId", ...read, w.updateTime);
  router.delete("/time/:logId", ...read, w.deleteTime);
  router.get("/timesheet", ...read, w.getTimesheet);

  // calendar
  router.get("/calendar", ...read, w.getCalendar);
  router.post("/calendar", ...read, w.saveEvent);
  router.patch("/calendar/:eventId", ...read, w.saveEvent);
  router.post("/calendar/:eventId/toggle", ...read, w.toggleEvent);
  router.delete("/calendar/:eventId", ...read, w.deleteEvent);

  // checklists
  router.get("/checklists", ...read, w.getChecklists);
  router.post("/checklists", ...write, w.saveList);
  router.patch("/checklists/:listId", ...write, w.saveList);
  router.delete("/checklists/:listId", ...write, w.deleteList);
  router.post("/checklists/:listId/start", ...read, w.startList);
  router.post("/checklist-items", ...read, w.createItem);
  router.patch("/checklist-items/:itemId", ...read, w.updateItem);
  router.post("/checklist-items/:itemId/toggle", ...read, w.toggleItem);
  router.delete("/checklist-items/:itemId", ...read, w.deleteItem);
  return router;
};
