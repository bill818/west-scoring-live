-- Phase 2c.6: soft-delete tracking for classes.
-- deleted_at = NULL   → class file is (or was) present in Ryegate
-- deleted_at = <iso>  → engine detected the .cls file removed from disk
-- On any new .cls POST for this class, deleted_at reverts to NULL
-- (so restoring the file via Flavor A download + copy-back is reversible).

ALTER TABLE classes ADD COLUMN deleted_at TEXT;
