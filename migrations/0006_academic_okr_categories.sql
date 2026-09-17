-- Tag academic OKRs so the college-tracker Progress tab can filter to education only
UPDATE okrs SET category = 'education' WHERE id IN ('KR-ACAD-1', 'KR-ACAD-2');
