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
- Optional infrastructure is controlled by a field on `EnvironmentConfig` and a profile
  overlay, never by an ad-hoc `if` on `envName` inside a stack. A new optional resource
  adds a flag, defaults it to the safe value in `base`, and gets a test asserting both its
  presence under `standard` and its absence under `minimal`.
- `profile=minimal` is a dev-only convenience. It may never drop a DLQ, a redrive policy,
  an alarm, a conditional write or the outbox. If a cost saving requires touching any of
  those, it needs an ADR, not a flag (D-035, INV-45).
- The `Ecr` stack is deployed and pushed to before any stack that consumes the image.
  Never move the repository back in with the service that pulls from it (D-037).
