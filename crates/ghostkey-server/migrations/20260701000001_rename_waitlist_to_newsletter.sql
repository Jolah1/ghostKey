-- Rename the early-access waitlist to a general newsletter list.
--
-- The app is open now, so the "waitlist" framing is retired. The table
-- is a sealed email list either way, so a plain rename preserves every
-- existing signup (and its indexes/unique constraint move with it).
--
-- The crypto seal context stays the string "waitlist" in code on
-- purpose: it's an internal key-derivation label, and keeping it stable
-- is what lets addresses collected before this rename still decrypt.
ALTER TABLE waitlist RENAME TO newsletter_subscribers;
