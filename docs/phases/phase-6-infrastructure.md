# Phase 6 — AWS CDK v2 infrastructure

## Scope

- `network`: multi-AZ VPC, VPC endpoints for DynamoDB/SQS/Secrets Manager/CloudWatch, security groups.
- `data`: DynamoDB table with PITR, deletion protection, encryption, streams, TTL, sparse GSIs.
- `messaging`: queues, DLQs, redrive policies, visibility timeouts aligned to Lambda timeouts.
- `workers`: Lambda functions, event source mappings with `reportBatchItemFailures` and `maxConcurrency`, reserved concurrency, the EventBridge schedule.
- `api`: ALB, Fargate service across AZs, deployment circuit breaker, autoscaling, deregistration delay, `stopTimeout`, health checks.
- `monitoring`: alarms for DLQ depth, queue age, 5xx rate, Lambda errors/throttles, DynamoDB throttling, unhealthy targets, workflow failure rate.
- Least-privilege IAM throughout. Read the `aws-review` skill before implementing.

## Out of scope

Deployment. Nothing is deployed in this phase.

## Acceptance criteria

- `pnpm cdk:synth` exits 0.
- CDK unit tests assert the values the application depends on: visibility timeout vs Lambda timeout, ALB idle vs keep-alive, partial batch reporting enabled, stream view type, PITR and deletion protection in production, no wildcard IAM on the workflow path.
