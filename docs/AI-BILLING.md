# Echo AI billing

Admin: `/admin/echo?tab=ai-configuration`, Usage & billing.
Admin-only. AI billing is not displayed in client dashboards, and no client billing API routes are registered.

- Account summaries cover all persisted AI usage, with name/email search and pagination. CAD and USD balances remain separate.
- Unbilled is completed, accepted paid usage not yet invoiced. Included/failed usage is not billable. Outstanding combines unbilled charges and unpaid invoice balances.
- Select unbilled lines for one client/currency and issue an itemized invoice (up to 500 lines). The invoice snapshots the account name/email, accepted per-use amounts, model, dates, note and due date. It remains private in the admin dashboard; Print / Save PDF opens the browser print dialog.
- Record received payments, including partial payments, with method and receipt/reference. Paid totals reconcile with partial receipts; overpayments are rejected. Invoice creation/payment retries are idempotent. Concurrent requests cannot double-invoice a line or overpay an invoice.
- Void only invoices without payments, retaining their lines and reason. Already received money cannot be silently voided. No deletion, automatic debit, refunds, new tax calculation or email sending is performed.
- Legacy manually referenced usage remains visible. Its existing payment/void controls remain available only when no new invoice owns the line.
- Invoices/usage updates use MongoDB transactions, requiring a replica set (the deployed Atlas database supports this). No migration or rewrite of historical charges is required.
- All billing routes require an administrator session. Invoice totals are customer charges, distinct from provider cost estimates; unmeasured provider costs remain explicit in admin totals.

Verification: `node --test --test-isolation=none src/ai-billing.test.js` starts a temporary isolated local MongoDB replica set and removes its test data on exit. It never connects to production.
