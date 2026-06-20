-- Early-access waitlist for the landing page.
--
-- Signups are opt-in marketing contacts, so unlike analytics (which is
-- aggregate-only) we must keep the address to reach people later. We do
-- NOT store it in the clear: the email is sealed at rest under the
-- server master key (same XChaCha20-Poly1305 scheme as heir/owner
-- contacts, with a fixed "waitlist" context), and a separate SHA-256
-- hash of the normalized address gives us dedupe without a plaintext
-- index. A DB leak alone yields neither the address nor a usable lookup.

CREATE TABLE waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- SHA-256 (hex) of the trimmed, lowercased email. Unique so a repeat
    -- signup is a no-op rather than a duplicate row.
    email_hash TEXT NOT NULL UNIQUE,

    -- The email, sealed at rest (context "waitlist"). Recoverable by the
    -- server when it's time to email the list; opaque to a DB reader.
    email_ciphertext TEXT NOT NULL,
    email_nonce      TEXT NOT NULL,

    -- Optional free-text source/referrer (which CTA they signed up from),
    -- same character class as analytics labels.
    source TEXT,

    created_at TEXT NOT NULL
);
