insert into public.vendors (name) values ('amazon');

drop view public.trending_items;

alter table public.tracked_items
  rename column ebay_item_id to vendor_item_id;

alter table public.tracked_items
  add column vendor text references public.vendors (name),
  add column url text;

update public.tracked_items
set
  vendor = 'ebay',
  url = case
    when vendor_item_id ~ '^\d+$'
      then 'https://www.ebay.com/itm/' || vendor_item_id
    when vendor_item_id ~ '^v1\|\d+\|\d+$'
      then 'https://www.ebay.com/itm/' || split_part(vendor_item_id, '|', 2)
  end;

alter table public.tracked_items
  alter column vendor set not null;

alter table public.tracked_items
  drop constraint tracked_items_user_id_ebay_item_id_key,
  add constraint tracked_items_user_id_vendor_vendor_item_id_key
    unique (user_id, vendor, vendor_item_id);

alter table public.profiles
  add column preferred_currency text not null default 'USD'
    check (preferred_currency ~ '^[A-Z]{3}$');

alter table public.api_usage
  drop constraint api_usage_service_check,
  add constraint api_usage_service_check
    check (service in ('ebay', 'brightdata', 'frankfurter', 'llm'));

create view public.trending_items
with (security_invoker = true) as
  select vendor, vendor_item_id, name, count(*) as tracker_count
  from public.tracked_items
  group by vendor, vendor_item_id, name
  order by tracker_count desc, name;

revoke all on public.trending_items from anon, authenticated;
