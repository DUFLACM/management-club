-- 现有已发布活动也需到期核验；通过现有队列的 lease/retry 自动补处理。
INSERT INTO jobs (id, type, payload, dedupe_key, run_after, priority)
SELECT gen_random_uuid(), 'activity.settle_attendance', jsonb_build_object('activityId', a.id),
       'attendance-settle:' || a.id::text,
       GREATEST(a.end_at, p.checkin_close_at, p.checkout_close_at) + interval '1 millisecond', 6
FROM activities a
LEFT JOIN attendance_policies p ON p.activity_id = a.id
WHERE a.status = 'published'
  AND EXISTS (SELECT 1 FROM activity_participants ap WHERE ap.activity_id = a.id AND ap.required = true)
  AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.dedupe_key = 'attendance-settle:' || a.id::text AND j.status IN ('queued', 'running'));
