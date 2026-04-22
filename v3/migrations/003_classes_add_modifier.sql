-- Phase 2b+: scoring_modifier column — captures col[3] of the .cls header
-- for jumper-lens classes (J / T / U-with-inferred-method). Per method,
-- col[3] means different things:
--   method 6 (IV.1 Optimum): 0 = 1-round, 1 = 2-round variant (possibly
--                            also enables JO — not fully confirmed 2026-04-22)
--   method 7 (Timed Eq):     0 = Forced,  1 = Scored
--   other methods:           captured as raw int, interpreted downstream
--
-- For hunter (class_type=H) this field stays NULL — hunter's col[3]
-- semantics aren't confirmed and we don't guess across lenses (Article 1).

ALTER TABLE classes ADD COLUMN scoring_modifier INTEGER;
