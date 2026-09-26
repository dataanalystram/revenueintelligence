# ADR 0005 — Pluggable qualification, human overrides, separation from policy

- Status: Accepted
- Date: 2026-09-26

## 1. Qualification is pluggable

```
                     ┌── RulesQualificationProvider   (deterministic, versioned ruleset)
QualificationProvider┼── JevQualificationProvider     (adapter to the hosted Jev service)
                     └── future: trained ML model, other AI service, customer engine
```

- One interface: `qualify(candidate snapshot) → QualificationDecision` in
  canonical terms.
- **Jev is an external hosted service behind an adapter.** Jev
  request/response types exist only inside the adapter. Business code sees
  only canonical decisions.
- Per-tenant **qualification mode**:
  - `rules` — the rules provider only.
  - `jev` — Jev only. If Jev is unavailable the outcome is `needs_review`;
    it never falls back to a silent guess.
  - `hybrid` — rules first. A rule that matches decisively (for example,
    demo request plus known decision maker → HOT) is final. Otherwise the
    candidate goes to Jev, which evaluates the more complex combination of
    usage, engagement, ownership and marketing behaviour.
- Outcomes: `hot`, `warm`, `cold`, `needs_review`.

## 2. Every decision is recorded

`QualificationDecision` stores:

- tenant and subject (lead candidate or lead)
- provider kind, name and version (model version or ruleset version)
- mode
- outcome and confidence (if available)
- reason codes and the signals they refer to
- input snapshot reference and SHA-256 hash
- timestamp and correlation id

Whether a human later overrode it is derived from the override history, never
stored as a mutable flag.

## 3. Human decisions take precedence

- A human override (`set`) becomes the effective temperature until a human
  explicitly changes it again (`set`) or hands control back to automation
  (`release`).
- We preserve the original automated decision, who changed it, when, the
  previous value, the new value and an optional reason. Overrides are
  append-only.
- **A later automated result never replaces an active override.** It is still
  recorded. If it disagrees, it is flagged for review (it appears in
  _Needs Review_) and never applied.
- This is implemented as pure, tested domain logic
  (`resolveEffectiveQualification`, M1).

## 4. Qualification is not business policy

| Qualification (provider)                                      | Business policy (deterministic, tenant config, M14) |
| ------------------------------------------------------------- | --------------------------------------------------- |
| _What kind of lead is this?_ HOT / WARM / COLD / NEEDS_REVIEW | _What do we do with it?_                            |
|                                                               | HOT → 1-hour SLA, direct 1:1 sales engagement       |
|                                                               | WARM → 24-hour SLA, sequence eligible               |
|                                                               | COLD → 3-day SLA, nurture / sequence                |

Jev can never set SLAs, routing, sequence enrolment or CRM actions. Its only
output is a classification.
