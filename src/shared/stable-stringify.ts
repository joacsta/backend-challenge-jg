/**
 * Deterministic JSON serialization used to fingerprint idempotent payloads.
 *
 * JSON.stringify only guarantees key order for objects created in a specific
 * way. Sorting every object (including nested ones) lets the same logical
 * payload produce the same hash even when its keys arrive in a different order.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nested]) =>
          `${JSON.stringify(key)}:${stableStringify(nested)}`,
      );
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}
