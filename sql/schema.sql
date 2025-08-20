begin;
create table if not exists public.agents (
  id text primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  name text,
  bot_token_enc text,
  openai_key_enc text,
  model text not null default 'gpt-5-nano',
  system_prompt text not null default 'Ты ИИ-продавец. Пиши обычным текстом, без JSON. Не повторяй вопросы. После слота и контакта подтверждай и заверши.',
  manager_chat_id text,
  intent_keywords text not null default 'записаться, звонок, консультация, встреча, заявка',
  timezone text not null default 'Europe/Amsterdam',
  sheets_webhook_url text,
  calendar_webhook_url text,
  crm_mode text default 'off',
  crm_webhook_url text,
  created_at timestamp with time zone default now()
);

create table if not exists public.tg_users (
  chat_id text not null,
  agent_id text references public.agents(id) on delete cascade,
  username text,
  first_name text,
  last_name text,
  created_at timestamp with time zone default now(),
  primary key (chat_id, agent_id)
);

create table if not exists public.states (
  chat_id text not null,
  agent_id text references public.agents(id) on delete cascade,
  stage text not null default 'idle',
  start_iso text,
  end_iso text,
  contact text,
  updated_at timestamp with time zone default now(),
  primary key (chat_id, agent_id)
);

create table if not exists public.leads (
  id bigserial primary key,
  chat_id text not null,
  agent_id text references public.agents(id) on delete cascade,
  username text,
  contact text,
  start_iso text,
  end_iso text,
  notes text,
  created_at timestamp with time zone default now()
);

create table if not exists public.processed_updates (
  update_id bigint not null,
  agent_id text references public.agents(id) on delete cascade,
  created_at timestamp with time zone default now(),
  primary key (update_id, agent_id)
);

alter table public.agents enable row level security;
alter table public.tg_users enable row level security;
alter table public.states enable row level security;
alter table public.leads enable row level security;
alter table public.processed_updates enable row level security;

drop policy if exists "owner read agents" on public.agents;
drop policy if exists "owner read leads" on public.leads;
drop policy if exists "owner read states" on public.states;
drop policy if exists "owner read tg_users" on public.tg_users;

create policy "owner read agents" on public.agents
for select to authenticated
using ( owner_id = auth.uid() );

create policy "owner read leads" on public.leads
for select to authenticated
using ( exists (select 1 from public.agents a where a.id = leads.agent_id and a.owner_id = auth.uid()) );

create policy "owner read states" on public.states
for select to authenticated
using ( exists (select 1 from public.agents a where a.id = states.agent_id and a.owner_id = auth.uid()) );

create policy "owner read tg_users" on public.tg_users
for select to authenticated
using ( exists (select 1 from public.agents a where a.id = tg_users.agent_id and a.owner_id = auth.uid()) );

revoke select on public.agents from anon, authenticated;
revoke select on public.leads from anon, authenticated;
revoke select on public.states from anon, authenticated;
revoke select on public.tg_users from anon, authenticated;
commit;
