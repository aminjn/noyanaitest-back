/**
 * Recursively strips any object key that starts with "$" (Mongo/Mongoose
 * query operators such as $ne, $gt, $regex, $where, $expr, ...) from a
 * plain object/array, at any depth. Meant for values that get fed straight
 * into a Mongoose filter (e.g. `Model.find(req.query)`) so a caller can't
 * smuggle operator syntax through query-string nesting (`?field[$ne]=`,
 * parsed by Express's `qs`) - see AUDIT/FIXES_TODO.md F-09,
 * AUDIT/10_SECURITY_FINDINGS.md Finding 10.3.
 *
 * Non-plain-object values (strings, numbers, ObjectIds, Dates, etc.) are
 * returned as-is.
 */
export function stripMongoOperators<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((item) => stripMongoOperators(item)) as unknown as T;
  }
  if (
    input !== null &&
    typeof input === "object" &&
    Object.getPrototypeOf(input) === Object.prototype
  ) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      input as Record<string, unknown>,
    )) {
      if (key.startsWith("$")) continue;
      result[key] = stripMongoOperators(value);
    }
    return result as unknown as T;
  }
  return input;
}
