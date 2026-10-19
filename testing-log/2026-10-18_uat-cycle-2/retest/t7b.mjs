import { call, rec, sql } from "./h.mjs";
const P = "bc20f19b-264a-4675-a30f-6a71c487b664", DAN = "dc87e62b-6bfb-4d83-a3d0-b095b4f3b4b5";
try {
  sql(`update profiles set role='admin' where id='${DAN}'`);
  rec("t7b-admins", sql("select count(*) from profiles where workspace_id='3c8968e0-9577-40db-bc92-39750736abd1' and role='admin'"));
  const e = await call("manager", "POST", `/api/projects/${P}/expenses`, { description: "T7b retest big expense", amount: 25000, category: "other" });
  const d = await call("manager", "DELETE", `/api/expenses/${e.json.data.id}`, { reason: "T7b two admins present" });
  rec("t7b-delete", { status: d.status, tier: d.json?.data?.tier });
  const dr = d.json.data.id;
  const pr = await call("priya", "POST", `/api/deletion-requests/${dr}/approve`, {});
  rec("t7b-priya", { status: pr.status, body: pr.text });
  const ad = await call("admin", "POST", `/api/deletion-requests/${dr}/approve`, {});
  rec("t7b-admin", { status: ad.status, body: ad.text });
  rec("t7b-expense-gone", sql(`select count(*) from expenses where id='${e.json.data.id}'`));
} finally {
  sql(`update profiles set role='member' where id='${DAN}'`);
  rec("t7b-reverted", sql(`select role from profiles where id='${DAN}'`));
}
