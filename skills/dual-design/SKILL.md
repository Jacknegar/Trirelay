---
name: dual-design
description: >-
  Anti-anchoring dual-track architecture design workflow using `relay_design`.
  Runs the advisor engine from raw requirements without leaking the host draft,
  seals the host draft hash, and reveals both with a 4-section synthesis template.
---

# Dual-Track Anti-Anchoring Design (`relay_design`)

Use for system architecture, data/schema design, core algorithms, or major refactors.

1. **Start sealed advisor track** (never pass your own draft here):
   ```json
   {
     "action": "start",
     "requirement": "<user requirement + objective constraints>",
     "contextPaths": ["src/core.py"]
   }
   ```
   (`background: true` recommended for large codebases.)
2. **Draft your own independent design** as the host coordinator without reading the advisor's output.
3. **Seal your draft**:
   ```json
   {
     "action": "submit_host",
     "designId": "<designId>",
     "hostDraft": "<your independent design>"
   }
   ```
4. **Reveal & Synthesize**:
   Call `relay_design(action="reveal", designId="<designId>")`. Verify every codebase claim made by the advisor against real files, then synthesize into:
   1. Consensus conclusions
   2. Adopted from advisor (with verified facts)
   3. Rejected from advisor (with empirical evidence)
   4. Open trade-offs for user decision
