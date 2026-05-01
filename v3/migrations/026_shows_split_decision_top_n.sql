-- 026: per-show split-decision top-N.
--
-- Bill 2026-04-30: split-decision flag (multi-judge hunter classes
-- where any judge's top-N ranking differs from the overall placed
-- top-N) was hardcoded to top-3 in v2. v3 makes N a per-show admin
-- setting so a show can tighten (top-2) or loosen (top-5) per its
-- own conventions. Default 3 matches v2 behavior.
--
-- Range expected 2-10; admin UI clamps. Class.html reads the value
-- via state.show.split_decision_top_n and passes to
-- WEST.rules.isSplitDecision.

ALTER TABLE shows ADD COLUMN split_decision_top_n INTEGER NOT NULL DEFAULT 3;
