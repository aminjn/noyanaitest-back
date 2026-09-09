export const userRoles = ["user", "admin", "notadmin"] as const;

export type UserRole = (typeof userRoles)[number];

export const pageLimit = 25;

// Org types that carry ACL-based access control. Lives here (rather than in
// Controllers/aclController.ts, which used to define it) so that Models/Secretary.ts
// and Controllers/aclController.ts can both depend on it without depending on each
// other — see AUDIT/02_DEPENDENCY_ANALYSIS.md Finding 2.1.
export const nodesWithAcl = [
  "doctor",
  "insurance",
  "pharmacy",
  "clinic",
  "paraClinic",
  "hospital",
] as const;

export type NodeWithAcl = (typeof nodesWithAcl)[number];
