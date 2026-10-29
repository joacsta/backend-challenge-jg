import { Injectable } from "@nestjs/common";
import * as AWS from "aws-sdk";
import { OutboxMessageEntity } from "../persistence/entities/outbox-message.entity";
import { getSqsEndpoint, isSqsTlsEnabled } from "./sqs-endpoint";

@Injectable()
export class SqsTransportService {
  private readonly client: AWS.SQS | null;

  constructor() {
    const queueUrl = process.env.AWS_SQS_OUTBOX_URL;
    if (!queueUrl) {
      this.client = null;
      return;
    }

    const endpoint = getSqsEndpoint();
    this.client = new AWS.SQS({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      sslEnabled: isSqsTlsEnabled(endpoint),
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

  async publish(message: OutboxMessageEntity): Promise<void> {
    if (!this.client) {
      return;
    }

    const queueUrl = process.env.AWS_SQS_OUTBOX_URL!;
    const body = JSON.stringify({
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
    });

    await this.client
      .sendMessage({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageAttributes: {
          eventType: {
            DataType: "String",
            StringValue: message.eventType,
          },
        },
      })
      .promise();
  }

  async publishDeadLetter(
    message: OutboxMessageEntity,
    reason = "max-retries-exceeded",
  ): Promise<void> {
    if (!this.client || !process.env.AWS_SQS_OUTBOX_DLQ_URL) {
      return;
    }

    const queueUrl = process.env.AWS_SQS_OUTBOX_DLQ_URL!;
    const body = JSON.stringify({
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      reason,
      dlq: true,
    });

    await this.client
      .sendMessage({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageAttributes: {
          eventType: {
            DataType: "String",
            StringValue: message.eventType,
          },
          reason: {
            DataType: "String",
            StringValue: reason,
          },
        },
      })
      .promise();
  }

  async publishInboxDeadLetter(
    payload: unknown,
    messageId: string,
    attempts: number,
    reason: string,
  ): Promise<void> {
    if (!this.client || !process.env.AWS_SQS_INBOX_DLQ_URL) {
      return;
    }

    await this.client
      .sendMessage({
        QueueUrl: process.env.AWS_SQS_INBOX_DLQ_URL,
        MessageBody: JSON.stringify({
          messageId,
          payload,
          attempts,
          reason,
          dlq: true,
        }),
        MessageAttributes: {
          reason: {
            DataType: "String",
            StringValue: reason,
          },
        },
      })
      .promise();
  }
}
