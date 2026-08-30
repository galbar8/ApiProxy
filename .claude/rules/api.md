# Rules: apps/api

- HTTP handlers never implement polling mechanics. They call `WorkflowWaiter` (INV-53).
- `tenantId` comes only from the authenticated credential. A `tenantId` in the body is
  ignored, not merged, not preferred (INV-70).
- Reads go through the tenant-checked repository method. A tenant mismatch returns `404`
  (INV-71, INV-72).
- No path may transition a workflow to `FAILED` because of an HTTP event: deadline
  expiry, client disconnect, `SIGTERM` and ALB timeouts leave state untouched (INV-51).
- Timeouts and delays come from config, never from literals in handler code.
- `SIGTERM` flips readiness first, then drains. Business correctness must not depend on
  the drain completing.
- Never log the `authorization` header, the raw API key, or a full request body that may
  contain customer data.
