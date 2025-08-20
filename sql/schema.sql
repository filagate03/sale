begin;

-- 1) Колонка owner_id в agents
alter table public.agents add column if not exists owner_id uuid;

-- FK только если его ещё нет
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agents_owner_fk'
      and conrelid = 'public.agents'::regclass
  ) then
    alter table public.agents
      add constraint agents_owner_fk
      foreign key (owner_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- Индекс на владельца
create index if not exists idx_agents_owner on public.agents(owner_id);

-- 2) Бэкенд-совместимость: перенос владельца из старой таблицы связей (если она была)
-- Возьмём любого имеющегося владельца, если owner_id пуст.
update public.agents a
set owner_id = ao.user_id
from public.agent_owners ao
where ao.agent_id = a.id
  and a.owner_id is null;

-- 3) Включаем RLS и переопределяем политики под owner_id
alter table public.agents enable row level security;
alter table public.tg_users enable row level security;
alter table public.states enable row level security;
alter table public.leads enable row level security;

-- Сносим старые политики, если стояли
drop policy if exists "owners read agents" on public.agents;
drop policy if exists "owner read agents"   on public.agents;
drop policy if exists "owners read leads"   on public.leads;
drop policy if exists "owner read leads"    on public.leads;
drop policy if exists "owners read states"  on public.states;
drop policy if exists "owner read states"   on public.states;
drop policy if exists "owners read tg_users" on public.tg_users;
drop policy if exists "owner read tg_users"  on public.tg_users;

-- Создаём актуальные
create policy "owner read agents" on public.agents
for select to authenticated
using ( owner_id = auth.uid() );

create policy "owner read leads" on public.leads
for select to authenticated
using (
  exists (
    select 1 from public.agents a
    where a.id = leads.agent_id
      and a.owner_id = auth.uid()
  )
);

create policy "owner read states" on public.states
for select to authenticated
using (
  exists (
    select 1 from public.agents a
    where a.id = states.agent_id
      and a.owner_id = auth.uid()
  )
);

create policy "owner read tg_users" on public.tg_users
for select to authenticated
using (
  exists (
    select 1 from public.agents a
    where a.id = tg_users.agent_id
      and a.owner_id = auth.uid()
  )
);

-- Подчищаем лишние права на всякий случай
revoke select on public.agents from anon, authenticated;
revoke select on public.leads  from anon, authenticated;
revoke select on public.states from anon, authenticated;
revoke select on public.tg_users from anon, authenticated;

commit;
