# Sugar lead handover — field intent (M15 input)

- Status: **preserved intent, not implemented**. Retired from the M2 table
  `tenant_field_mappings` in Milestone 8 (ADR 0020 §19); input for the future
  lead-handover write milestone (M15).
- Origin: the Juniper tenant template (`config/tenant-templates/juniper.json`,
  key `fieldMappings`) as it stood at the end of M7. Every row is reproduced
  verbatim below. The M8 retirement migration refused to run unless every
  stored row was exactly one of these rows.
- These are **outbound / bidirectional** Sugar **Leads** mappings (writes to
  Sugar). They are deliberately **not** converted into M8 inbound mapping
  versions: M8 is read-only, and these describe what the platform will write.
- `tbc` means the Sugar field is not known yet; it must never be guessed.

| #   | System  | Object  | Canonical entity | Canonical field             | External field | Direction     | Status   | Notes (verbatim)                                                                                                                      |
| --- | ------- | ------- | ---------------- | --------------------------- | -------------- | ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `sugar` | `Leads` | `lead`           | `stage`                     | `status`       | bidirectional | proposed | Brief D.2: existing static Status field. Picklist translation and velocity reporting via the stage-date fields still to be confirmed. |
| 2   | `sugar` | `Leads` | `lead`           | `lead_type`                 | — (`tbc`)      | outbound      | tbc      | Brief D.2: check whether an equivalent picklist already exists.                                                                       |
| 3   | `sugar` | `Leads` | `lead`           | `source_label`              | — (`tbc`)      | outbound      | tbc      | Brief: Heat indicators; values should match the Pathway 1 trigger list.                                                               |
| 4   | `sugar` | `Leads` | `lead`           | `temperature`               | — (`tbc`)      | bidirectional | tbc      | Brief: Lead Label (Hot/Warm/Cold). Sales edits in Sugar sync back.                                                                    |
| 5   | `sugar` | `Leads` | `lead`           | `disqualified_reason`       | — (`tbc`)      | bidirectional | tbc      | Brief: picklist only, identical values both sides.                                                                                    |
| 6   | `sugar` | `Leads` | `lead`           | `date_entered_new`          | — (`tbc`)      | outbound      | tbc      | Brief: new field required in Sugar.                                                                                                   |
| 7   | `sugar` | `Leads` | `lead`           | `date_entered_attempting`   | — (`tbc`)      | outbound      | tbc      | Brief: new field required in Sugar.                                                                                                   |
| 8   | `sugar` | `Leads` | `lead`           | `date_entered_connected`    | — (`tbc`)      | outbound      | tbc      | Brief: new field required in Sugar.                                                                                                   |
| 9   | `sugar` | `Leads` | `lead`           | `date_entered_qualified`    | — (`tbc`)      | outbound      | tbc      | Brief: new field required in Sugar.                                                                                                   |
| 10  | `sugar` | `Leads` | `lead`           | `date_entered_disqualified` | — (`tbc`)      | outbound      | tbc      | Brief: new field required in Sugar.                                                                                                   |

Machine-readable copy (exact JSON as it was in the template):

```json
[
  {
    "system": "sugar",
    "objectType": "Leads",
    "canonicalEntity": "lead",
    "canonicalField": "stage",
    "externalField": "status",
    "direction": "bidirectional",
    "status": "proposed",
    "notes": "Brief D.2: existing static Status field. Picklist translation and velocity reporting via the stage-date fields still to be confirmed."
  },
  {
    "system": "sugar",
    "objectType": "Leads",
    "canonicalEntity": "lead",
    "canonicalField": "lead_type",
    "externalField": null,
    "direction": "outbound",
    "status": "tbc",
    "notes": "Brief D.2: check whether an equivalent picklist already exists."
  },
  {
    "system": "sugar",
    "objectType": "Leads",
    "canonicalEntity": "lead",
    "canonicalField": "source_label",
    "externalField": null,
    "direction": "outbound",
    "status": "tbc",
    "notes": "Brief: Heat indicators; values should match the Pathway 1 trigger list."
  },
  {
    "system": "sugar",
    "objectType": "Leads",
    "canonicalEntity": "lead",
    "canonicalField": "temperature",
    "externalField": null,
    "direction": "bidirectional",
    "status": "tbc",
    "notes": "Brief: Lead Label (Hot/Warm/Cold). Sales edits in Sugar sync back."
  },
  {
    "system": "sugar",
    "objectType": "Leads",
    "canonicalEntity": "lead",
    "canonicalField": "disqualified_reason",
    "externalField": null,
    "direction": "bidirectional",
    "status": "tbc",
    "notes": "Brief: picklist only, identical values both sides."
  },
  {
    "system": "sugar",
    "objectType": "Leads",
    "canonicalEntity": "lead",
    "canonicalField": "date_entered_new",
    "externalField": null,
    "direction": "outbound",
    "status": "tbc",
    "notes": "Brief: new field required in Sugar."
  },
  {
    "system": "sugar",
    "objectType": "Leads",
    "canonicalEntity": "lead",
    "canonicalField": "date_entered_attempting",
    "externalField": null,
    "direction": "outbound",
    "status": "tbc",
    "notes": "Brief: new field required in Sugar."
  },
  {
    "system": "sugar",
    "objectType": "Leads",
    "canonicalEntity": "lead",
    "canonicalField": "date_entered_connected",
    "externalField": null,
    "direction": "outbound",
    "status": "tbc",
    "notes": "Brief: new field required in Sugar."
  },
  {
    "system": "sugar",
    "objectType": "Leads",
    "canonicalEntity": "lead",
    "canonicalField": "date_entered_qualified",
    "externalField": null,
    "direction": "outbound",
    "status": "tbc",
    "notes": "Brief: new field required in Sugar."
  },
  {
    "system": "sugar",
    "objectType": "Leads",
    "canonicalEntity": "lead",
    "canonicalField": "date_entered_disqualified",
    "externalField": null,
    "direction": "outbound",
    "status": "tbc",
    "notes": "Brief: new field required in Sugar."
  }
]
```
