import { describe, expect, test } from "bun:test";
import { resolveInboxMessageId } from "../../src/infrastructure/messaging/sqs-inbox-consumer.service";

describe("resolveInboxMessageId", () => {
  test("uses the stable envelope id instead of the SQS message id", () => {
    const body = { id: "event-1", payload: { eventId: "event-1" } };

    expect(resolveInboxMessageId(body, "sqs-1")).toBe("event-1");
    expect(resolveInboxMessageId(body, "sqs-2")).toBe("event-1");
  });

  test("uses the payload event id when the envelope has no id", () => {
    expect(
      resolveInboxMessageId({ payload: { eventId: "event-2" } }, "sqs-3"),
    ).toBe("event-2");
  });

  test("keeps an explicit envelope message id", () => {
    expect(
      resolveInboxMessageId({ messageId: "explicit", id: "event-1" }, "sqs-4"),
    ).toBe("explicit");
  });

  test("falls back to the SQS message id for legacy payloads", () => {
    expect(resolveInboxMessageId({ payload: { amount: "1" } }, "sqs-5")).toBe(
      "sqs-5",
    );
  });
});
