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
-- Custo de produção detalhado por componente (a coluna "cost" acima passa a
-- ser sempre a SOMA dos três abaixo — continua existindo pra não quebrar o
-- que já usa "cost", como o custo registrado em cada venda).
alter table products add column if not exists cost_packaging numeric not null default 0; -- embalagem
alter table products add column if not exists cost_roasting numeric not null default 0;  -- torra
alter table products add column if not exists cost_stickers numeric not null default 0;  -- adesivos

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

-- Como é um app privado de uso familiar (sem login), liberamos acesso
-- completo para quem tiver a chave "anon" do projeto (que fica só no
-- código do site, não é pública na internet por si só).
drop policy if exists "allow all products" on products;
create policy "allow all products" on products
  for all using (true) with check (true);

drop policy if exists "allow all sales" on sales;
create policy "allow all sales" on sales
  for all using (true) with check (true);

drop policy if exists "allow all stock_entries" on stock_entries;
create policy "allow all stock_entries" on stock_entries
  for all using (true) with check (true);

drop policy if exists "allow all clients" on clients;
create policy "allow all clients" on clients
  for all using (true) with check (true);

drop policy if exists "allow all sellers" on sellers;
create policy "allow all sellers" on sellers
  for all using (true) with check (true);

drop policy if exists "allow all receivables" on receivables;
create policy "allow all receivables" on receivables
  for all using (true) with check (true);

drop policy if exists "allow all receivable_payments" on receivable_payments;
create policy "allow all receivable_payments" on receivable_payments
  for all using (true) with check (true);

drop policy if exists "allow all recompra_contacts" on recompra_contacts;
create policy "allow all recompra_contacts" on recompra_contacts
  for all using (true) with check (true);

drop policy if exists "allow all order_deliveries" on order_deliveries;
create policy "allow all order_deliveries" on order_deliveries
  for all using (true) with check (true);

drop policy if exists "allow all cash_registers" on cash_registers;
create policy "allow all cash_registers" on cash_registers
  for all using (true) with check (true);

drop policy if exists "allow all cash_movements" on cash_movements;
create policy "allow all cash_movements" on cash_movements
  for all using (true) with check (true);

drop policy if exists "allow all cash_transfer_allocations" on cash_transfer_allocations;
create policy "allow all cash_transfer_allocations" on cash_transfer_allocations
  for all using (true) with check (true);

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
