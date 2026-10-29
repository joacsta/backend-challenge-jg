import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import * as AWS from "aws-sdk";
import {
  InboxMessageService,
  type InboxEnvelope,
} from "./inbox-message.service";
import {
  WageringApplicationService,
  type SubmitWagerInput,
} from "../../application/wagering/wagering-application.service";
import { SqsTransportService } from "./sqs-transport.service";
import { MetricsService } from "../observability/metrics.service";

@Injectable()
export class SqsInboxConsumerService {
  private readonly client: AWS.SQS | null;

  constructor(
    private readonly inboxMessageService: InboxMessageService,
    private readonly wageringApplicationService: WageringApplicationService,
    private readonly sqsTransport: SqsTransportService,
    private readonly metrics: MetricsService,
  ) {
    const queueUrl = process.env.AWS_SQS_INBOX_URL;
    if (!queueUrl) {
      this.client = null;
      return;
    }

    this.client = new AWS.SQS({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.AWS_SQS_ENDPOINT ?? "http://localhost:4566",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      sslEnabled: false,
    });
  }

  async probe(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      await this.client.listQueues({ MaxResults: 1 }).promise();
      return true;
    } catch {
      return false;
    }
  }

  async pollOnce(limit = 10): Promise<number> {
    if (!this.client) {
      return 0;
    }

    const queueUrl = process.env.AWS_SQS_INBOX_URL!;
    const result = await this.client
      .receiveMessage({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: limit,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 30,
        AttributeNames: ["ApproximateReceiveCount"],
      })
      .promise();

    const messages = result.Messages ?? [];

    for (const message of messages) {
      const startedAt = Date.now();
      const attempts = Number(
        message.Attributes?.ApproximateReceiveCount ?? "1",
      );
      const messageId = message.MessageId ?? message.Body ?? "unknown";

      try {
        const body = message.Body ? JSON.parse(message.Body) : null;
        if (!body || typeof body !== "object") {
          throw new PermanentMessageError("Invalid SQS message body");
        }

        const envelope: InboxEnvelope<unknown> = {
          consumerName: body.consumerName ?? "sqs-inbox",
          messageId: body.messageId ?? message.MessageId ?? body.id,
          payload: body.payload ?? body,
        };

        await this.inboxMessageService.consume(
          envelope,
          async (transactionManager, payload) => {
            let request: {
              input: SubmitWagerInput;
              idempotencyKey: string;
            };
            try {
              request = this.extractWagerRequest(payload);
            } catch (error) {
              throw new PermanentMessageError(
                error instanceof Error
                  ? error.message
                  : "Invalid wager message",
              );
            }
            await this.wageringApplicationService.submitWager(
              request.input,
              request.idempotencyKey,
              transactionManager,
            );
          },
        );

        await this.deleteMessage(queueUrl, message.ReceiptHandle);
        this.metrics.increment("inbox.processed");
        this.metrics.observe("inbox.latency_ms", Date.now() - startedAt);
      } catch (error) {
        if (this.isBusinessError(error)) {
          await this.deleteMessage(queueUrl, message.ReceiptHandle);
          this.metrics.increment("inbox.business_ack");
          continue;
        }

        if (
          error instanceof PermanentMessageError ||
          attempts >= this.maxAttempts()
        ) {
          await this.sqsTransport.publishInboxDeadLetter(
            message.Body ?? null,
            messageId,
            attempts,
            error instanceof Error ? error.message : "permanent-error",
          );
          await this.deleteMessage(queueUrl, message.ReceiptHandle);
          this.metrics.increment("inbox.dlq");
        } else {
          this.metrics.increment("inbox.retry");
        }
      }

    }

    return messages.length;
  }

  private async deleteMessage(
      queueUrl: string,
      receiptHandle?: string,
    ): Promise<void> {
      if (!this.client || !receiptHandle) {
        return;
      }

      await this.client
        .deleteMessage({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle })
        .promise();
    }

    private isBusinessError(error: unknown): boolean {
      return (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException ||
        (error instanceof HttpException && error.getStatus() < 500)
      );
    }

    private maxAttempts(): number {
      return Number(process.env.INBOX_MAX_ATTEMPTS ?? "5");
    }

  private extractWagerRequest(payload: unknown): {
    input: SubmitWagerInput;
    idempotencyKey: string;
  } {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid wager message payload");
    }

    const body = payload as Record<string, unknown>;
    const data =
      body.data && typeof body.data === "object"
        ? (body.data as Record<string, unknown>)
        : body;
    const idempotencyKey =
      typeof data.idempotencyKey === "string" ? data.idempotencyKey : undefined;

    if (!idempotencyKey) {
      throw new Error("Wager message idempotencyKey is required");
    }

    const input = {
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: data.money,
      referenceExternalTransactionId: data.referenceExternalTransactionId,
      correlationId:
        typeof body.correlationId === "string"
          ? body.correlationId
          : idempotencyKey,
    };

    if (
      typeof input.providerId !== "string" ||
      typeof input.externalTransactionId !== "string" ||
      typeof input.playerId !== "string" ||
      typeof input.walletId !== "string" ||
      typeof input.roundId !== "string" ||
      typeof input.gameId !== "string" ||
      !["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"].includes(
        input.kind as string,
      ) ||
      !input.money ||
      typeof input.money !== "object"
    ) {
      throw new Error("Invalid wager message data");
    }

    return {
      input: input as SubmitWagerInput,
      idempotencyKey,
    };
  }
}

class PermanentMessageError extends Error {}
