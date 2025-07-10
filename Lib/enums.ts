export const userRoles = ["user", "admin"] as const;

export type UserRole = (typeof userRoles)[number];

export const pageLimit = 25;
