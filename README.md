# recombyne

Recombyne landing and API app for real-time, engagement-weighted sentiment intelligence across prediction markets and stocks, with Gemini-powered chatbot, Supabase waitlist capture, and Vercel deployment.

## Features

- Landing page with SEO + structured data
- Chat assistant powered by Gemini via backend `/api/chat`
- Waitlist form saved to Supabase via `/api/waitlist`
- Duplicate waitlist detection with friendly UX
- Protected CSV export endpoint: `/api/waitlist/export`
- Admin export UI at `/admin`
- Health endpoint at `/api/health`
- Optional success and failure webhook notifications for waitlist ops
- Lightweight web analytics via Plausible

## Environment Variables

Copy `.env.example` to `.env` for local development:

- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_WAITLIST_TABLE`
- `ADMIN_EXPORT_TOKEN`
- `WAITLIST_NOTIFY_WEBHOOK_URL` (optional)
- `WAITLIST_NOTIFY_WEBHOOK_BEARER` (optional)
- `WAITLIST_ALERT_WEBHOOK_URL` (optional)
- `WAITLIST_ALERT_WEBHOOK_BEARER` (optional)
- `PORT`

## Local Run

```bash
npm run dev
```

Open:

- `http://localhost:3000`
- `http://localhost:3000/admin`

## Waitlist Export

- Endpoint: `GET /api/waitlist/export`
- Auth: header `x-admin-token: <ADMIN_EXPORT_TOKEN>` or `?token=<ADMIN_EXPORT_TOKEN>`
- Download format: CSV

## Key Rotation Runbook (No Downtime)

When rotating Gemini or Supabase keys:

1. Create new key in provider dashboard.
2. Add/override in Vercel Project > Environment Variables.
3. Redeploy production (`vercel deploy --prod` or push to `main`).
4. Verify:
   - `/api/health` reports configured checks
   - waitlist form submissions succeed
   - chatbot replies succeed
5. Revoke old key only after verification.

## Deployment

- Hosted on Vercel with custom domain `recombyne.com`.
- DNS (Namecheap):
  - `A @ -> 76.76.21.21`
  - `CNAME www -> cname.vercel-dns.com`
