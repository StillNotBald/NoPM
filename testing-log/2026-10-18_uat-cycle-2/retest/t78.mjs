import { call, rec, sql } from "./h.mjs";
const P = "bc20f19b-264a-4675-a30f-6a71c487b664";
const e = await call("manager", "POST", `/api/projects/${P}/expenses`, { description: "T7 retest big expense", amount: 25000, category: "other" });
rec("t7-create", { status: e.status, id: e.json?.data?.id, err: e.text.slice(0,200) });
const id = e.json?.data?.id;
const d = await call("manager", "DELETE", `/api/expenses/${id}`, { reason: "T7 retest deletion over threshold" });
rec("t7-delete", { status: d.status, tier: d.json?.data?.tier, drid: d.json?.data?.id, text: d.text.slice(0,300) });
const dr = d.json?.data?.id;
const pr = await call("priya", "POST", `/api/deletion-requests/${dr}/approve`, {});
rec("t7-priya-approve", { status: pr.status, body: pr.text });
const ad = await call("admin", "POST", `/api/deletion-requests/${dr}/approve`, {});
rec("t7-admin-approve", { status: ad.status, body: ad.text });
rec("t7-expense-gone", sql(`select count(*) from expenses where id='${id}'`));
// small expense control
const e2 = await call("manager", "POST", `/api/projects/${P}/expenses`, { description: "T7 retest small expense", amount: 500, category: "other" });
const d2 = await call("manager", "DELETE", `/api/expenses/${e2.json?.data?.id}`, { reason: "T7 control below threshold" });
rec("t7-control-small", { status: d2.status, tier: d2.json?.data?.tier });
// T8 approved doc
const docs = sql("select id from documents where status='approved' and project_id='" + P + "' limit 1");
rec("t8-doc-in-B1", docs);
