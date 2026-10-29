import { getSqsEndpoint, isSqsTlsEnabled } from "../../src/infrastructure/messaging/sqs-endpoint";

describe("SQS endpoint security", () => {
  const clearEnvironment = () => {
    delete process.env.AWS_SQS_ENDPOINT;
    delete process.env.NODE_ENV;
  };

  test("allows HTTP only for local development endpoints", () => {
    process.env.AWS_SQS_ENDPOINT = "http://localhost:4566";
    expect(getSqsEndpoint()).toBe("http://localhost:4566");
    expect(isSqsTlsEnabled(getSqsEndpoint())).toBe(false);
    clearEnvironment();
  });

  test("rejects a non-local HTTP endpoint in production", () => {
    process.env.AWS_SQS_ENDPOINT = "http://sqs.example.test";
    process.env.NODE_ENV = "production";
    try {
      getSqsEndpoint();
      throw new Error("expected insecure endpoint rejection");
    } catch (error) {
      expect(String(error)).toContain("must use HTTPS");
    }
    clearEnvironment();
  });

  test("enables TLS for HTTPS endpoints", () => {
    process.env.AWS_SQS_ENDPOINT = "https://sqs.example.test";
    expect(isSqsTlsEnabled(getSqsEndpoint())).toBe(true);
    clearEnvironment();
  });
});
