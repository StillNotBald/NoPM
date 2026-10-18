export type ClashRow = {
  id: string;
  reference_id: string | null;
  title: string;
  type: string;
  severity: string;
  status: string;
  description: string | null;
  over_allocation_pct: number | null;
  recommended_action: string | null;
  project_a_id: string | null;
  project_b_id: string | null;
};
