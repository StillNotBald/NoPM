-- Maker withdrawal, step 2 of 2: teach the four-eyes CHECK about 'withdrawn'.
-- Withdrawal is the requester's own act, so it carries NO approver — four-eyes
-- still binds every checker decision (approved / rejected / committed).
alter table deletion_requests drop constraint maker_checker_different;
alter table deletion_requests add constraint maker_checker_different check (
  status = 'pending'
  or (status = 'withdrawn' and approved_by_id is null)
  or (approved_by_id is not null and approved_by_id <> requested_by_id)
);
