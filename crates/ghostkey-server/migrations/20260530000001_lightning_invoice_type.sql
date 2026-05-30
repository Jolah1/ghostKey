-- Add invoice_type to lightning_invoices so the poller can distinguish
-- a regular check-in payment from a panic-stop payment.
ALTER TABLE lightning_invoices ADD COLUMN invoice_type TEXT NOT NULL DEFAULT 'checkin';
