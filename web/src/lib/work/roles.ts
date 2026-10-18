import type { Actor } from "@/lib/auth/guard";
import { ScopeError } from "@/lib/api/errors";

/** The role of the human behind the actor (a token follows its creator). */
export function principalRoleOf(actor: Actor): string | null {
  const role = actor.type === "user" ? actor.role : actor.principalRole;
  return role ?? null;
}

export function isManagerOrAdmin(actor: Actor): boolean {
  const role = principalRoleOf(actor);
  return role === "admin" || role === "manager";
}

/** 403 unless the actor (or the human behind a token) is a manager or admin. */
export function requireManagerOrAdmin(actor: Actor, message: string): void {
  if (!isManagerOrAdmin(actor)) throw new ScopeError(message, "role_not_permitted");
}

export const PROGRAM_ATTACH_MESSAGE = "Only a manager or admin can move a project into or out of a program.";
export const REOPEN_PROJECT_MESSAGE = "Only a manager or admin can reopen a completed project.";
export const RESOLVE_CLASH_MESSAGE = "Only a manager or admin can resolve a clash by hand.";
