-- Waitlist table for Recombyne landing page
create table if not exists public.waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role text not null,
  source text not null default 'landing_page',
  utm_source text,
  utm_medium text,
  utm_campaign text,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists waitlist_signups_email_unique
  on public.waitlist_signups ((lower(email)));

create index if not exists waitlist_signups_created_at_idx
  on public.waitlist_signups (created_at desc);

-- Keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists waitlist_signups_set_updated_at on public.waitlist_signups;
create trigger waitlist_signups_set_updated_at
before update on public.waitlist_signups
for each row
execute function public.set_updated_at();

-- Security defaults
alter table public.waitlist_signups enable row level security;

-- This table is written by backend service-role only.
-- No public policies are created intentionally.
