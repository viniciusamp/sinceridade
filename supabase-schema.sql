-- Rode este script inteiro no Supabase: menu "SQL Editor" > "New query" > colar > Run
-- (Se você já rodou uma versão antiga deste script antes, use o migration-2.sql em vez deste.)

create extension if not exists "pgcrypto";

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit text not null default 'un',
  quantity numeric not null default 0,
  min_stock numeric not null default 0,
  price numeric not null default 0,
  cost numeric not null default 0,
  last_modified_by text,
  created_at timestamptz not null default now()
);
-- Custo de produção detalhado por componente. As três colunas abaixo eram
-- os únicos "tipos" de custo possíveis (versão antiga) — a coluna "cost"
-- continua existindo e é sempre a SOMA do custo total do produto, pra não
-- quebrar nada que já usa "cost" (custo registrado em cada venda, cálculo
-- de lucro no Resumo, etc.).
alter table products add column if not exists cost_packaging numeric not null default 0; -- embalagem (legado)
alter table products add column if not exists cost_roasting numeric not null default 0;  -- torra (legado)
alter table products add column if not exists cost_stickers numeric not null default 0;  -- adesivos (legado)

-- Itens de custo LIVRES por produto — em vez de só 3 campos fixos, cada
-- produto pode ter quantos itens de custo quiser, com o nome que quiser
-- (Embalagem, Torra, Frete, Mão de obra, Imposto, o que surgir). A soma de
-- todos os itens de um produto é o que preenche "products.cost".
create table if not exists product_cost_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  label text not null,
  amount numeric not null default 0,
  position int not null default 0, -- ordem de exibição na tela
  created_at timestamptz not null default now()
);
alter table product_cost_items enable row level security;

drop policy if exists "authenticated only product_cost_items" on product_cost_items;
create policy "authenticated only product_cost_items" on product_cost_items
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Migra os valores que já existiam nas 3 colunas fixas pra itens de custo
-- de verdade, só na primeira vez (não duplica se você rodar de novo).
insert into product_cost_items (product_id, label, amount, position)
select id, 'Embalagem', cost_packaging, 0 from products
where cost_packaging > 0
  and not exists (select 1 from product_cost_items pci where pci.product_id = products.id and pci.label = 'Embalagem');

insert into product_cost_items (product_id, label, amount, position)
select id, 'Torra', cost_roasting, 1 from products
where cost_roasting > 0
  and not exists (select 1 from product_cost_items pci where pci.product_id = products.id and pci.label = 'Torra');

insert into product_cost_items (product_id, label, amount, position)
select id, 'Adesivos', cost_stickers, 2 from products
where cost_stickers > 0
  and not exists (select 1 from product_cost_items pci where pci.product_id = products.id and pci.label = 'Adesivos');

create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete set null,
  product_name text not null,
  unit text,
  quantity numeric not null,
  unit_price numeric not null,
  discount numeric not null default 0,
  payment_method text not null default 'dinheiro',
  cost_at_sale numeric not null default 0,
  total numeric not null,
  logged_by text,
  sold_at timestamptz not null default now()
);

create table if not exists stock_entries (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete set null,
  product_name text not null,
  unit text,
  quantity numeric not null,
  unit_cost numeric not null default 0,
  total_cost numeric not null default 0,
  note text,
  logged_by text,
  entered_at timestamptz not null default now()
);

-- Movimentações de estoque (entrada/saída) — essa tabela já existia mas
-- nunca era usada; agora vira o "livro-caixa" do estoque. Toda venda passa
-- a gerar automaticamente uma saída aqui (sem duplicar nada), e entradas
-- manuais (compra de fornecedor etc.) também passam a ficar registradas.
alter table stock_entries add column if not exists movement_type text not null default 'entrada'; -- entrada | saida
alter table stock_entries add column if not exists location text; -- Manhuaçu | BH
alter table stock_entries add column if not exists order_key uuid; -- pedido relacionado, quando a saída vem de uma venda
alter table stock_entries add column if not exists reason text; -- motivo (Venda, Compra de fornecedor, Ajuste, etc.)
-- Transferência entre localidades: liga as duas pontas (saída numa
-- localidade + entrada na outra) com um mesmo protocolo, igual ao que já
-- existe pra transferência entre caixas.
alter table stock_entries add column if not exists transfer_group_id uuid; -- protocolo que liga as duas pontas da transferência
alter table stock_entries add column if not exists related_location text; -- a "outra" localidade envolvida na transferência

-- Clientes
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text,
  phone text,
  city text,
  birthday date,
  created_at timestamptz not null default now()
);

-- Vendedores
create table if not exists sellers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  created_at timestamptz default now()
);

-- Vincula vendas a cliente e vendedor, e agrupa itens de uma mesma venda (carrinho)
alter table sales add column if not exists client_id uuid references clients(id) on delete set null;
alter table sales add column if not exists client_name text;
alter table sales add column if not exists seller_id uuid references sellers(id) on delete set null;
alter table sales add column if not exists seller_name text;
alter table sales add column if not exists sale_group_id uuid;

-- Contas a receber (gerado automaticamente quando uma venda é "à prazo")
create table if not exists receivables (
  id uuid primary key default gen_random_uuid(),
  sale_group_id uuid,
  client_id uuid references clients(id) on delete set null,
  client_name text not null,
  amount numeric not null default 0,
  paid_amount numeric not null default 0,
  status text not null default 'aberto', -- aberto | parcial | pago
  note text,
  created_at timestamptz not null default now()
);

-- Histórico de pagamentos/cobranças de cada conta a receber
create table if not exists receivable_payments (
  id uuid primary key default gen_random_uuid(),
  receivable_id uuid references receivables(id) on delete cascade,
  amount numeric not null,
  note text,
  paid_at timestamptz not null default now()
);
alter table receivable_payments add column if not exists payment_method text; -- pix | dinheiro | cartao

-- Registro de contatos de recompra (histórico de quando a equipe avisou o
-- cliente que a recompra estava chegando). NÃO guarda a previsão em si —
-- a previsão é sempre recalculada a partir do histórico de vendas, então
-- fica automaticamente atualizada a cada nova compra.
create table if not exists recompra_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete set null,
  client_name text,
  product_id uuid references products(id) on delete set null,
  product_name text,
  contacted_by text,
  note text,
  contacted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ── Caixa (livro-caixa) ────────────────────────────────────────────────────
-- Um caixa é só um "cofre" nomeado (Caixa BH, Caixa Manhuaçu, Banco, Pix...).
-- O saldo NUNCA é guardado direto nele — é sempre calculado a partir da soma
-- das movimentações, pra nunca ficar dessincronizado.
create table if not exists cash_registers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- Livro-caixa. Alimentado automaticamente por vendas recebidas na hora e por
-- quitações de Contas a Receber, além de lançamentos manuais (entrada, saída
-- ou transferência entre caixas). "origin_type"/"origin_id" apontam pra
-- operação que gerou o lançamento, quando existir — não duplica nada que já
-- existe em "sales" ou "receivables", só referencia.
create table if not exists cash_movements (
  id uuid primary key default gen_random_uuid(),
  cash_register_id uuid references cash_registers(id) on delete set null,
  movement_type text not null, -- entrada | saida
  amount numeric not null,
  description text not null, -- histórico da movimentação
  origin_type text not null default 'manual', -- venda | recebimento | manual | transferencia
  origin_id uuid, -- sale_group_id (venda) ou receivable id (recebimento), quando houver
  transfer_group_id uuid, -- liga as duas pernas de uma transferência entre caixas
  related_cash_register_id uuid references cash_registers(id) on delete set null, -- o "outro lado" de uma transferência
  logged_by text,
  note text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Conciliação: liga uma transferência de caixa (pelo transfer_group_id) aos
-- pedidos que ela quitou, e por quanto cada um. Uma transferência pode
-- quitar vários pedidos, e um pedido pode ser quitado por várias
-- transferências diferentes (recebimento parcial ao longo do tempo).
create table if not exists cash_transfer_allocations (
  id uuid primary key default gen_random_uuid(),
  transfer_group_id uuid not null,
  receivable_id uuid references receivables(id) on delete set null,
  receivable_payment_id uuid references receivable_payments(id) on delete set null,
  sale_group_id uuid,
  client_name text,
  amount numeric not null,
  created_at timestamptz not null default now()
);


-- aqui só guardamos se o pedido já foi entregue/retirado ou não).
-- order_key = sale_group_id da venda (ou o próprio id da venda, quando ela
-- não faz parte de um carrinho agrupado) — assim não duplicamos nada que já
-- existe em "sales" nem mexemos no estoque de novo.
create table if not exists order_deliveries (
  id uuid primary key default gen_random_uuid(),
  order_key uuid not null unique,
  client_id uuid references clients(id) on delete set null,
  client_name text,
  status_delivery text not null default 'pendente', -- pendente | entregue
  delivered_at timestamptz,
  delivered_by text,
  note text,
  created_at timestamptz not null default now()
);

-- Ativa segurança por linha (exigido pelo Supabase)
alter table products enable row level security;
alter table sales enable row level security;
alter table stock_entries enable row level security;
alter table clients enable row level security;
alter table sellers enable row level security;
alter table receivables enable row level security;
alter table receivable_payments enable row level security;
alter table recompra_contacts enable row level security;
alter table order_deliveries enable row level security;
alter table cash_registers enable row level security;
alter table cash_movements enable row level security;
alter table cash_transfer_allocations enable row level security;

-- Como agora existe login de verdade (Supabase Auth), só libera acesso
-- pra quem estiver autenticado — a chave "anon" sozinha não abre mais
-- nada. Ver seção "Usuários e Auditoria" mais abaixo.
drop policy if exists "allow all products" on products;
drop policy if exists "authenticated only products" on products;
create policy "authenticated only products" on products
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "allow all sales" on sales;
drop policy if exists "authenticated only sales" on sales;
create policy "authenticated only sales" on sales
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "allow all stock_entries" on stock_entries;
drop policy if exists "authenticated only stock_entries" on stock_entries;
create policy "authenticated only stock_entries" on stock_entries
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "allow all clients" on clients;
drop policy if exists "authenticated only clients" on clients;
create policy "authenticated only clients" on clients
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "allow all sellers" on sellers;
drop policy if exists "authenticated only sellers" on sellers;
create policy "authenticated only sellers" on sellers
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "allow all receivables" on receivables;
drop policy if exists "authenticated only receivables" on receivables;
create policy "authenticated only receivables" on receivables
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "allow all receivable_payments" on receivable_payments;
drop policy if exists "authenticated only receivable_payments" on receivable_payments;
create policy "authenticated only receivable_payments" on receivable_payments
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "allow all recompra_contacts" on recompra_contacts;
drop policy if exists "authenticated only recompra_contacts" on recompra_contacts;
create policy "authenticated only recompra_contacts" on recompra_contacts
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "allow all order_deliveries" on order_deliveries;
drop policy if exists "authenticated only order_deliveries" on order_deliveries;
create policy "authenticated only order_deliveries" on order_deliveries
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "allow all cash_registers" on cash_registers;
drop policy if exists "authenticated only cash_registers" on cash_registers;
create policy "authenticated only cash_registers" on cash_registers
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "allow all cash_movements" on cash_movements;
drop policy if exists "authenticated only cash_movements" on cash_movements;
create policy "authenticated only cash_movements" on cash_movements
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "allow all cash_transfer_allocations" on cash_transfer_allocations;
drop policy if exists "authenticated only cash_transfer_allocations" on cash_transfer_allocations;
create policy "authenticated only cash_transfer_allocations" on cash_transfer_allocations
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Ativa atualização em tempo real (pra sincronizar entre os dois aparelhos)
-- Usa bloco protegido porque, se a tabela já estiver na publicação
-- (por ex. rodando este script mais de uma vez), o ALTER daria erro.
do $$
begin
  begin
    alter publication supabase_realtime add table products;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table sales;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table stock_entries;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table clients;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table sellers;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table receivables;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table receivable_payments;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table recompra_contacts;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table order_deliveries;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table cash_registers;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table cash_movements;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table cash_transfer_allocations;
  exception when others then null; end;
end $$;

-- ============================================================
-- USUÁRIOS E AUDITORIA
-- ============================================================
-- A partir daqui o app usa login de verdade (Supabase Auth) em vez da
-- senha fixa que ficava escrita no código. Cada pessoa tem sua própria
-- conta (criada pelo painel do Supabase — veja o passo a passo no
-- README). O RLS acima já foi travado pra só aceitar usuário autenticado.

-- Nome de exibição de cada usuário (o Supabase Auth só guarda e-mail/senha;
-- isso aqui é só o "nome bonito" que aparece no app e na auditoria).
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);
alter table profiles enable row level security;

drop policy if exists "profiles select authenticated" on profiles;
create policy "profiles select authenticated" on profiles
  for select using (auth.role() = 'authenticated');

drop policy if exists "profiles update own" on profiles;
create policy "profiles update own" on profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Cria automaticamente um "profile" (com nome de exibição) toda vez que
-- uma conta nova é criada no Supabase Auth. Se você preencher o campo
-- "User Metadata" com {"display_name": "Fulano"} na hora de criar o
-- usuário no painel, esse nome é usado; senão, usa a parte antes do @
-- do e-mail como nome padrão.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Log de auditoria: registra AUTOMATICAMENTE, direto no banco, toda vez
-- que alguém cria/edita/apaga algo em qualquer tabela do sistema — com
-- protocolo, quem fez, quando e o que mudou. Isso roda como um "gatilho"
-- (trigger) do próprio Postgres, então funciona mesmo que alguém tente
-- mexer direto na API sem passar pelo app — não dá pra burlar client-side.
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  protocol text not null,           -- código curto pra referência, tipo #A1B2C3
  table_name text not null,
  record_id uuid,
  action text not null,             -- insert | update | delete
  changed_by uuid references auth.users(id) on delete set null,
  changed_by_name text,             -- guarda o nome também, pra não sumir se o usuário for removido depois
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
alter table audit_log enable row level security;

drop policy if exists "audit_log select authenticated" on audit_log;
create policy "audit_log select authenticated" on audit_log
  for select using (auth.role() = 'authenticated');
-- Ninguém pode inserir/editar/apagar manualmente — só o trigger grava aqui
-- (ele roda como "security definer", com permissão própria, sem depender
-- de o usuário ter permissão de escrita nessa tabela).

create or replace function public.log_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_user_name text;
  v_protocol text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
begin
  select display_name into v_user_name from public.profiles where id = v_user_id;

  if tg_op = 'DELETE' then
    insert into public.audit_log(protocol, table_name, record_id, action, changed_by, changed_by_name, old_data)
    values (v_protocol, tg_table_name, old.id, 'delete', v_user_id, v_user_name, to_jsonb(old));
    return old;
  elsif tg_op = 'UPDATE' then
    insert into public.audit_log(protocol, table_name, record_id, action, changed_by, changed_by_name, old_data, new_data)
    values (v_protocol, tg_table_name, new.id, 'update', v_user_id, v_user_name, to_jsonb(old), to_jsonb(new));
    return new;
  else
    insert into public.audit_log(protocol, table_name, record_id, action, changed_by, changed_by_name, new_data)
    values (v_protocol, tg_table_name, new.id, 'insert', v_user_id, v_user_name, to_jsonb(new));
    return new;
  end if;
end;
$$;

-- Liga o gatilho de auditoria em todas as tabelas de negócio do sistema.
do $$
declare
  t text;
begin
  foreach t in array array[
    'products','sales','stock_entries','clients','sellers',
    'receivables','receivable_payments','recompra_contacts','order_deliveries',
    'cash_registers','cash_movements','cash_transfer_allocations','product_cost_items'
  ]
  loop
    execute format('drop trigger if exists trg_audit_%1$s on %1$s;', t);
    execute format(
      'create trigger trg_audit_%1$s after insert or update or delete on %1$s for each row execute function public.log_audit_event();',
      t
    );
  end loop;
end $$;

do $$
begin
  begin
    alter publication supabase_realtime add table profiles;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table audit_log;
  exception when others then null; end;
  begin
    alter publication supabase_realtime add table product_cost_items;
  exception when others then null; end;
end $$;
