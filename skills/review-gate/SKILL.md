---
name: review-gate
description: >-
  Bounded 2-round adversarial code review gate (`relay_review_gate`) distinguishing
  `blocking` (must include `trigger_path`) from `advisory` findings and upgrading
  effort to `xhigh` automatically on sensitive paths.
---

# Bounded 2-Round Review Gate (`relay_review_gate`)

1. Run `relay_review_gate(gateKey="<feature>", engine="both")` before final merge/delivery.
2. Changes touching `auth`, `billing`, `credentials`, `publish/deploy`, `persistence`, or `eval/baseline` paths automatically run at `xhigh` effort.
3. Fix only `blocking` findings (which include a concrete `trigger_path`); record `advisory` notes without stalling.
4. On round 3+, the gate returns `decision: "escalate_to_user"` with `remainingBlockingFindings` so the coordinator stops looping and escalates to the user.
