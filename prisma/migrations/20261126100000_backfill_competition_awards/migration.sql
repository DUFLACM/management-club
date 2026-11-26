-- 旧版补录奖项时可能只更新报名成绩，账本仍只有参赛分。
-- 沿用原流水的计分月、类别和规则版本，追加已确认总分与实记分之间的差额。
BEGIN;

-- 与新版导入、人工审核的赛事行锁协调，避免计算差额时并发改分。
LOCK TABLE competition_events IN EXCLUSIVE MODE;
LOCK TABLE competition_registrations, team_competition_entries IN SHARE MODE;
LOCK TABLE points_ledger IN SHARE ROW EXCLUSIVE MODE;

WITH contest_points AS (
    SELECT user_id, source_key, amount, status, category,
           split_part(source_key, ':', 2) AS event_key,
           split_part(source_key, ':topup:', 1) AS base_key
    FROM points_ledger
    WHERE source_key LIKE 'competition:%' OR source_key LIKE 'team-competition:%'
), balances AS (
    SELECT event_key, user_id, min(base_key) AS base_key, sum(amount) AS credited
    FROM contest_points
    GROUP BY event_key, user_id
    -- 同一人同一场只能有一个明确的原始来源。已冲正或改归属的账目保留人工处理结果。
    HAVING count(DISTINCT base_key) = 1
       AND count(*) FILTER (WHERE source_key = base_key) = 1
       AND bool_and(status = 'approved' AND category IN ('award', 'contest'))
       AND bool_and(source_key = base_key OR source_key ~ ':topup:-?[0-9]+(\.[0-9]+)?$')
), original AS (
    SELECT p.id, p.user_id, p.source_key, p.category, p.score_month, p.rule_version_id,
           p.evidence_ref, b.credited, e.id AS event_id, e.title AS event_title
    FROM balances b
    JOIN points_ledger p ON p.user_id = b.user_id AND p.source_key = b.base_key
    JOIN competition_events e ON e.id::text = b.event_key AND e.scoring_mode = 'manual_review'
    WHERE NOT EXISTS (
        -- 旧版可能为同名同日比赛重复建档。成员若在两份档案均有流水，无法可靠区分同一份奖项。
        SELECT 1 FROM competition_events other
        JOIN contest_points other_score ON other_score.event_key = other.id::text
        WHERE other_score.user_id = p.user_id AND other.id <> e.id AND other.title = e.title
          AND (other.start_at AT TIME ZONE 'Asia/Shanghai')::date = (e.start_at AT TIME ZONE 'Asia/Shanghai')::date
    ) AND NOT EXISTS (
        SELECT 1 FROM points_ledger adjustment
        WHERE adjustment.user_id = p.user_id
          AND (adjustment.detail->>'eventId' = b.event_key OR adjustment.evidence_ref = p.evidence_ref
               OR adjustment.detail->>'relatedEntryId' = p.id::text)
          AND adjustment.source_key <> p.source_key
          AND NOT starts_with(adjustment.source_key, p.source_key || ':topup:')
    )
), targets AS (
    SELECT o.*, r.result_score AS target, r.result_detail->>'awardText' AS award_text,
           'competition_registration:' || r.id AS result_ref
    FROM original o
    JOIN competition_registrations r ON r.event_id = o.event_id AND r.user_id = o.user_id
    WHERE r.status = 'approved'
      AND o.source_key = 'competition:' || r.event_id || ':' || r.user_id

    UNION ALL

    SELECT o.*,
           CASE WHEN t.result_detail ? 'memberResults' OR t.result_detail->>'source' = 'competition_import'
                     THEN member.target
                WHEN t.result_detail ? 'tier' AND EXISTS (
                    SELECT 1 FROM team_members m
                    WHERE m.team_id = t.team_id AND m.user_id = o.user_id
                      AND m.joined_at <= t.reviewed_at
                      AND (m.left_at > t.reviewed_at OR (m.left_at IS NULL AND m.status = 'active'))
                ) THEN t.result_score
           END AS target,
           member.award_text, 'team_competition_entry:' || t.id AS result_ref
    FROM original o
    JOIN team_competition_entries t ON t.event_id = o.event_id
    -- 原始流水记录了当时的参赛人，人员变动后不从现役队员名单推断。
    LEFT JOIN LATERAL (
        SELECT min(CASE WHEN item->>'points' ~ '^[0-9]{1,10}([.][0-9]{1,20})?$'
                        THEN round((item->>'points')::numeric, 2) END) AS target,
               min(item->>'awardText') AS award_text
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.result_detail->'memberResults') = 'array'
                                       THEN t.result_detail->'memberResults' ELSE '[]'::jsonb END) AS item
        WHERE item->>'userId' = o.user_id::text
        HAVING count(*) = 1
    ) member ON true
    WHERE t.status = 'approved'
      AND o.source_key = 'team-competition:' || t.event_id || ':' || t.team_id || ':' || o.user_id
), missing AS (
    SELECT t.*, target - credited AS difference,
           source_key || ':topup:' || trim_scale(target)::text AS topup_key
    FROM targets t
    WHERE credited >= 0 AND target > credited AND target <= 99999999.9999
), posted AS (
    INSERT INTO points_ledger (
        id, user_id, source_key, category, amount, score_month, recorded_at, status,
        rule_version_id, evidence_ref, detail, idempotency_key
    )
    SELECT gen_random_uuid(), user_id, topup_key, category, difference, score_month, now(), 'approved',
           rule_version_id, result_ref,
           jsonb_strip_nulls(jsonb_build_object(
               'source', 'competition_award_backfill', 'eventId', event_id, 'eventTitle', event_title,
               'awardText', award_text, 'baseEntryId', id,
               'previousTotal', trim_scale(credited)::text, 'targetTotal', trim_scale(target)::text
           )), 'src:' || topup_key
    FROM missing
    ON CONFLICT DO NOTHING
    RETURNING id, user_id, amount, score_month, detail
), audited AS (
    INSERT INTO audit_logs (id, action, resource_type, resource_id, summary)
    SELECT gen_random_uuid(), 'points.post', 'points_ledger', id::text,
           format('历史正式赛「%s」自动补分：原 %s，应得 %s，补入 %s 分（%s）',
                  detail->>'eventTitle', detail->>'previousTotal', detail->>'targetTotal', trim_scale(amount), score_month)
    FROM posted
)
INSERT INTO user_notifications (id, user_id, kind, title, body, link)
SELECT gen_random_uuid(), user_id, 'points_change', '正式赛获奖积分已补记',
       format('「%s」本次补记 %s 分，归入 %s，本场合计 %s 分。',
              detail->>'eventTitle', trim_scale(amount), score_month, detail->>'targetTotal'),
       '/app?section=points'
FROM posted;

COMMIT;
