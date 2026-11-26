---
name: tri-boost
description: >-
  Run Boost mode across Antigravity, Claude Code, and Codex: independent parallel
  first-principles analysis followed by optional forked peer cross-critique.
---

# Tri-Engine Boost (`relay_orchestrate(pattern="boost")`)

1. Invoke `relay_orchestrate(pattern="boost", prompt="...", crossCritique=true, background=true)`.
2. Phase 1 runs independent analyses across non-host/selected models in parallel.
3. Phase 2 (`crossCritique: true`) **forks** each model's Phase 1 session (preventing concurrent writer collisions) and exchanges peer outputs to expose blind spots.
4. The host coordinator verifies factual claims directly in the workspace and delivers the final synthesis.
