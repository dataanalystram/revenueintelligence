# Delivery plan

We build and test one milestone at a time. We don't start the next milestone
until the current one's tests and Definition of Done pass. Each milestone is
committed separately with its own record in this folder.

| #   | Milestone                                           | Needs external access?                            |
| --- | --------------------------------------------------- | ------------------------------------------------- |
| 0   | Repository / infrastructure foundation              | No                                                |
| 1   | Canonical domain model                              | No                                                |
| 2   | Tenant model / isolation                            | No                                                |
| 3   | HubSpot developer environment / read connector      | HubSpot **developer test account** (we create it) |
| 4   | HubSpot connector abstraction                       | Dev test account                                  |
| 5   | HubSpot webhook receiver                            | Dev test account + public tunnel                  |
| 6   | Queue / idempotency / retry handling                | No                                                |
| 7   | Sugar connector interface + realistic mock          | No                                                |
| 8   | External-ID cross-reference system                  | No                                                |
| 9   | Configurable field-mapping engine                   | No                                                |
| 10  | Gainsight CS read-only connector + schema discovery | Gainsight CS access key                           |
| 11  | Signal aggregation into LeadCandidate               | No                                                |
| 12  | AI qualification provider ("Jev")                   | Model provider key (TBC)                          |
| 13  | Deterministic fallback qualification provider       | No                                                |
| 14  | Business policy / SLA / routing engine              | No                                                |
| 15  | Fully simulated end-to-end pipeline                 | No                                                |
| 16  | Real HubSpot validation                             | Juniper HubSpot install                           |
| 17  | Real Sugar read-only discovery                      | Juniper Sugar credentials                         |
| 18  | Controlled Sugar write testing                      | Juniper Sugar sandbox                             |
| 19  | Backward Sugar → HubSpot synchronisation            | Juniper Sugar                                     |
| 20  | Pilot / end-to-end QA                               | All                                               |
| 21  | Production-quality frontend / dashboard             | No                                                |

Records: [M0](M00-foundation.md) · [M1](M01-canonical-domain-model.md)
