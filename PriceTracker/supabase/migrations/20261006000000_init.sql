create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'user' check (role in ('user', 'admin')),
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.tracked_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  ebay_item_id text not null,
  name text not null,
  target_price numeric(12, 2) check (target_price >= 0),
  current_price numeric(12, 2) check (current_price >= 0),
  currency text,
  created_at timestamptz not null default now(),
  unique (user_id, ebay_item_id)
);

create table public.price_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.tracked_items (id) on delete cascade,
  price numeric(12, 2) not null check (price >= 0),
  currency text,
  recorded_at timestamptz not null default now()
);

create index price_history_item_id_recorded_at_idx
  on public.price_history (item_id, recorded_at);

create table public.vendors (
  name text primary key,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.vendors (name) values ('ebay');

create table public.api_usage (
  id bigint generated always as identity primary key,
  service text not null check (service in ('ebay', 'llm')),
  operation text not null,
  succeeded boolean not null,
  called_at timestamptz not null default now()
);

create index api_usage_service_called_at_idx
  on public.api_usage (service, called_at);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.tracked_items enable row level security;
alter table public.price_history enable row level security;
alter table public.vendors enable row level security;
alter table public.api_usage enable row level security;

create policy "Users can read their own profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

create policy "Users can read their own tracked items"
  on public.tracked_items for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can read price history for their own items"
  on public.price_history for select
  to authenticated
  using (
    exists (
      select 1
      from public.tracked_items
      where tracked_items.id = price_history.item_id
        and tracked_items.user_id = (select auth.uid())
    )
  );

create view public.trending_items
with (security_invoker = true) as
  select ebay_item_id, name, count(*) as tracker_count
  from public.tracked_items
  group by ebay_item_id, name
  order by tracker_count desc, name;

revoke all on public.trending_items from anon, authenticated;
