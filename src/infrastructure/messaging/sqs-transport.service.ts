import { Injectable } from "@nestjs/common";
import * as AWS from "aws-sdk";
import { OutboxMessageEntity } from "../persistence/entities/outbox-message.entity";

@Injectable()
export class SqsTransportService {
  private readonly client: AWS.SQS | null;

  constructor() {
    const queueUrl = process.env.AWS_SQS_OUTBOX_URL;
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
}
