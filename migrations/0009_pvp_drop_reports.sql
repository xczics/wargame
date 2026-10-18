-- 1.3.3: defence reports are mail (war-reports.defense, the full report in the message since 1.0.0); this copy was
-- written on every raid and read by nothing. No data to move.
DROP INDEX IF EXISTS pvp_reports_defender;
DROP TABLE IF EXISTS pvp_reports;
