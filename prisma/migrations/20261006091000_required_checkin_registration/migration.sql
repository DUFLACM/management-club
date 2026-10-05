-- 仅为尚未结束的已发布活动中已有成功入场签到的必到成员补齐报名。
WITH checked_in_members AS MATERIALIZED (
  SELECT p.activity_id, p.user_id, c.accepted_at, r.status AS from_status
  FROM activity_participants p
  JOIN activities a ON a.id = p.activity_id
  JOIN attendance_checkpoints c ON c.activity_id = p.activity_id AND c.user_id = p.user_id AND c.checkpoint = 'IN'
  LEFT JOIN activity_registrations r ON r.activity_id = p.activity_id AND r.user_id = p.user_id
  WHERE p.required = true AND a.status = 'published' AND a.end_at > now()
    AND (r.id IS NULL OR r.status <> 'enrolled')
), enrolled AS (
  INSERT INTO activity_registrations (id, activity_id, user_id, status, accepted_at)
  SELECT gen_random_uuid(), activity_id, user_id, 'enrolled', accepted_at
  FROM checked_in_members
  ON CONFLICT (activity_id, user_id) DO UPDATE SET
    status = 'enrolled', accepted_at = EXCLUDED.accepted_at, waitlist_seq = NULL,
    confirm_deadline = NULL, cancelled_at = NULL, cancel_reason = NULL,
    revision = activity_registrations.revision + 1, updated_at = now()
  RETURNING id, activity_id, user_id
)
INSERT INTO registration_history (id, registration_id, from_status, to_status, note)
SELECT gen_random_uuid(), e.id, m.from_status, 'enrolled', '必到成员现场签到成功，自动报名（历史数据补齐）'
FROM enrolled e
JOIN checked_in_members m ON m.activity_id = e.activity_id AND m.user_id = e.user_id;
