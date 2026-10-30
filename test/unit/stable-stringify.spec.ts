import { describe, expect, test } from "bun:test";
import { stableStringify } from "../../src/shared/stable-stringify";

describe("stableStringify", () => {
  test("sorts keys at every level", () => {
    const left = { data: { amount: "10.00", currency: "BRL" } };
    const right = { data: { currency: "BRL", amount: "10.00" } };

    expect(stableStringify(left)).toBe(stableStringify(right));
  });

  test("keeps nested values in the fingerprint", () => {
    const first = { data: { amount: "10.00" } };
    const second = { data: { amount: "20.00" } };

    expect(stableStringify(first)).not.toBe(stableStringify(second));
    expect(stableStringify(first)).toContain('"amount":"10.00"');
  });

  test("keeps arrays in order and serializes nulls consistently", () => {
    expect(stableStringify({ items: [1, 2], value: null })).toBe(
      '{"items":[1,2],"value":null}',
    );
    expect(stableStringify({ value: undefined })).toBe('{"value":null}');
  });
});
