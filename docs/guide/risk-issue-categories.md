# Risk and issue categories

NoPM tags each risk and each issue with one optional category. The two lists were written for NoPM. They follow the public PMBOK risk breakdown structure (technical, external, organisational, project management) and the ISO 31000 habit of grouping by source of uncertainty, in plain English.

## Risk categories (`risk_category`)

| Value | Label | Covers |
|---|---|---|
| `technical` | Technical | Technology, design, data and integration risk |
| `schedule` | Schedule | Timeline and sequencing risk |
| `cost` | Cost / Funding | Budget, funding and cost-estimate risk |
| `resourcing` | Resourcing | People, skills and capacity risk |
| `scope_requirements` | Scope / Requirements | Unclear, growing or changing scope |
| `supplier_external` | Supplier / External | Vendors, third parties and outside events |
| `regulatory_legal` | Regulatory / Legal | Compliance, contract and legal exposure |
| `organisational` | Organisational / Change | Operations, change adoption and stakeholders |

## Issue categories (`issue_category`)

| Value | Label | Covers |
|---|---|---|
| `technical_fault` | Technical fault | Defects, outages and data-quality faults |
| `resourcing` | Resourcing | People or capacity not available |
| `schedule_delay` | Schedule delay | Late work or blocked dependencies |
| `cost_overrun` | Cost / Funding | Overspend or funding gaps |
| `scope_change` | Scope change | Unplanned scope growth or change |
| `organisational` | Organisational | Stakeholder conflict, process bottlenecks |
| `supplier` | Supplier | Vendor or third-party problems |
| `external_event` | External event | Weather, market, regulator or other outside events |

Migration `20261017000085_risk_issue_taxonomy.sql` maps rows that carried earlier values onto these lists.
