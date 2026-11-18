revoke all on public.price_history from anon;

revoke insert, update, delete, truncate on public.price_history from authenticated;

grant select on public.price_history to authenticated;

alter publication supabase_realtime add table public.price_history;
