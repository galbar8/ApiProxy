# Rules: infrastructure/cdk

- Every value the application assumes about infrastructure is asserted by a CDK unit
  test: queue visibility timeout vs Lambda timeout, ALB idle vs Node keep-alive, stream
  view type, partial batch reporting, DLQ redrive counts.
- Production DynamoDB: PITR on, deletion protection on, encryption configured,
  `RemovalPolicy.RETAIN`. A non-production environment may differ, explicitly and by
  environment flag, never by accident.
- Every processing queue has a DLQ, a redrive policy and an alarm. A DLQ with no alarm
  is not an accepted failure mechanism (INV-45).
- IAM is least-privilege and resource-scoped. No `Resource: "*"` on the workflow path
  without a written justification in the same file.
- ECS runs across at least two AZs in production, with a deployment circuit breaker and a
  deregistration delay that fits the request budget.
- No `Vpc.fromLookup` or other context lookups: `cdk synth` must work without AWS
  credentials.
- Nothing is deployed without explicit human approval.
