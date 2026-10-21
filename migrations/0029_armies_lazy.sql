-- Short marches between one's own settlements (user 2026-10-21: "低于三分钟的，不设闹钟，……下次刷新时结算"): the
-- destination settlement of such a march, which has no timeline events and is applied when either settlement is next
-- read; NULL for every other march (arrival and return are timeline events).
ALTER TABLE armies_marches ADD COLUMN lazy_to TEXT;
