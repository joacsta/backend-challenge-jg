export function getSqsEndpoint(): string {
  const endpoint = process.env.AWS_SQS_ENDPOINT ?? "https://sqs.us-east-1.amazonaws.com";
  const isLocal =
    endpoint.startsWith("http://localhost") ||
    endpoint.startsWith("http://127.0.0.1") ||
    endpoint.startsWith("http://localstack");
  const isDevelopment = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";

  if (endpoint.startsWith("http://") && !isLocal && !isDevelopment) {
    throw new Error("AWS_SQS_ENDPOINT must use HTTPS outside local development");
  }

  return endpoint;
}

export function isSqsTlsEnabled(endpoint: string): boolean {
  return endpoint.startsWith("https://");
}
