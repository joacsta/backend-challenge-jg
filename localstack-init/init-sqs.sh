#!/usr/bin/env bash
set -euo pipefail

until awslocal sqs list-queues >/dev/null 2>&1; do
  sleep 1
done

awslocal sqs create-queue --queue-name wagering-outbox >/dev/null 2>&1 || true
awslocal sqs create-queue --queue-name wagering-inbox >/dev/null 2>&1 || true
awslocal sqs create-queue --queue-name wagering-outbox-dlq >/dev/null 2>&1 || true
awslocal sqs create-queue --queue-name wagering-inbox-dlq >/dev/null 2>&1 || true
