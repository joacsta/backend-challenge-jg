import { Injectable } from "@nestjs/common";
import * as AWS from "aws-sdk";
import { InboxMessageService, type InboxEnvelope } from "./inbox-message.service";

@Injectable()
export class SqsInboxConsumerService {
  private readonly client: AWS.SQS | null;

  constructor(private readonly inboxMessageService: InboxMessageService) {
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
      })
      .promise();

    const messages = result.Messages ?? [];

    for (const message of messages) {
      const body = message.Body ? JSON.parse(message.Body) : null;
      if (!body) {
        continue;
      }

      const envelope: InboxEnvelope<unknown> = {
        consumerName: body.consumerName ?? "sqs-inbox",
        messageId: body.messageId ?? message.MessageId ?? body.id,
        payload: body.payload ?? body,
      };

      await this.inboxMessageService.consume(envelope);

      if (message.ReceiptHandle) {
        await this.client
          .deleteMessage({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          })
          .promise();
      }
    }

    return messages.length;
  }
}
