-- Owned by plugin: resources. Armies never held resources, but advancing their timeline used to
-- write pools for them ("army:<id>"). Those rows meant nothing; the code no longer writes them.
DELETE FROM resources_balances WHERE holder LIKE 'army:%';
