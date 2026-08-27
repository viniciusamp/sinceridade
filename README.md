# Café Sinceridade Gestão — passo a passo

Este é um site pronto. Você só precisa: (1) criar o banco de dados no Supabase,
(2) colar duas informações no arquivo `config.js`, e (3) publicar a pasta.
Leva uns 10 minutos, sem precisar programar.

## Novidades desta versão

- **Transferência entre localidades (Manhuaçu ↔ BH) virou uma operação de
  verdade.** Na aba Movimentações, o botão "+ Registrar entrada/saída"
  ganhou uma terceira opção: **🔁 Transferência**. Você escolhe o produto,
  de qual localidade sai e pra qual vai, e o app:
  - **subtrai automaticamente** da localidade de origem e **soma** na de
    destino (é o mesmo produto só mudando de lugar — o estoque total dele
    não muda);
  - gera um **protocolo** (um número, tipo `#A1B2C3`) que liga as duas
    pontas do movimento, então dá pra rastrear a transferência inteira;
  - registra **quem fez**, quando, e uma observação opcional.
  - No livro-caixa de estoque, essa movimentação aparece com 🔁 e mostra
    "Transferência para/de [localidade] · Protocolo #...". Excluir uma
    transferência remove as duas pontas juntas, pra não sobrar um registro
    pela metade.
  - Transferências não contam nos totais de "Entradas"/"Saídas" nem no
    relatório por usuário (item 12) — senão inflaria os números, já que não
    é uma compra nem um consumo de verdade, só reorganização interna.

- **Exportar relatórios em Excel (aba Resumo):** dois botões novos —
  "Exportar vendas do mês" (planilha simples com as vendas do mês
  selecionado) e "Exportar relatório completo" (uma pasta de trabalho com 4
  abas: Resumo mensal, Vendas do mês, Estoque atual com markup de cada
  produto, e Contas a Receber). Serve pra apurar números e acompanhar metas
  fora do app, em ferramentas como Excel ou Google Sheets.
- **Tema claro/escuro:** botão 🌙/☀️ no cabeçalho. A escolha fica salva no
  navegador (cada aparelho lembra a preferência de quem usa nele).
- **App renomeado para "Café Sinceridade Gestão"** — título da aba, tela de
  login e cabeçalho atualizados.
- **Caixa: agora dá pra excluir uma movimentação** registrada por engano.
  Se for uma transferência entre caixas, apagar remove as duas pernas juntas
  (senão o saldo consolidado ficaria errado).
- **Estoque: quantidade só muda pela aba Movimentações.** Os botões de +/-
  e a edição direta de quantidade no cadastro do produto foram removidos —
  agora toda entrada ou saída de estoque **precisa** passar pela aba
  Movimentações, o que gera automaticamente o registro de quem fez, quando
  e por quê. A tela de Movimentações ganhou um botão único que alterna entre
  Entrada e Saída.
  - Produto novo nasce com estoque zerado — depois de criar, dê entrada na
    quantidade inicial pela aba Movimentações.
- **Custo de produção detalhado por produto:** ao invés de um campo único
  de custo, agora você informa separadamente **Embalagem**, **Torra** e
  **Adesivos** no cadastro do produto. O app soma tudo automaticamente e
  mostra o **lucro, a margem e o markup** em tempo real conforme você digita
  o preço de venda — clique em qualquer produto na aba Estoque pra ver/editar
  isso.

- **Caixa (nova aba) — livro-caixa de verdade.** Você cadastra os caixas que
  usa (ex.: Caixa BH, Caixa Manhuaçu, Banco, Pix) e o app mostra o saldo de
  cada um e o **saldo consolidado**. O saldo nunca é digitado — é sempre a
  soma das movimentações, então nunca fica dessincronizado.
  - **Venda recebida na hora** (Pix/Dinheiro/Cartão): ao registrar o
    pedido, você escolhe **qual caixa recebeu** o dinheiro (ou "Não lançar
    no caixa", se preferir não usar essa parte agora). Venda **à prazo**
    não mexe em caixa nenhum até ser paga de verdade.
  - **Quitação de Contas a Receber:** o modal de "Registrar pagamento"
    ganhou um campo de caixa — ao confirmar, a entrada é lançada sozinha.
  - **Lançamento manual:** botão "+ Nova movimentação" para Entrada, Saída
    ou **Transferência entre caixas** (gera duas pernas vinculadas — uma
    saída no caixa de origem, uma entrada no de destino — e o saldo
    consolidado não muda, porque é dinheiro só trocando de lugar).
  - Filtros: caixa, tipo (entrada/saída/transferência), período
    (Hoje/Ontem/Semana/Mês/Personalizado/Todos) e usuário.
  - Cada card de caixa tem editar (✎) e excluir (🗑) — só não deixa excluir
    um caixa que já tem movimentações, pra não perder histórico.
  - **Sobre "Contas a Pagar":** o pedido original mencionava isso, mas essa
    funcionalidade não existe no sistema hoje — só Contas a Receber. Não
    inventei um módulo de Contas a Pagar; deixei a estrutura do Caixa
    pronta pra plugar isso no futuro, se quiser.

- **Contas a Receber: quitação completa direto na tela.** Ao clicar no
  cliente, cada dívida agora mostra **de qual pedido** ela veio (nº do
  pedido, igual ao que aparece na aba Pedidos). O botão "Registrar
  pagamento" ganhou um campo de **forma de pagamento** (Pix/Dinheiro/Cartão)
  — cada quitação parcial fica registrada com a forma usada, e o histórico
  de pagamentos do cliente mostra isso também. Adicionei também uma busca
  por nome no topo da aba, pra achar o cliente rápido numa lista grande.
- **Movimentações: agora dá pra excluir um lançamento** — cada linha tem um
  🗑 pra remover um registro incorreto/duplicado do histórico. Importante:
  isso só apaga o registro do relatório, **não desfaz** a alteração no
  estoque do produto (se a movimentação errada também mudou a quantidade
  em estoque, corrija a quantidade separadamente no cadastro do produto).
- **Movimentações de estoque (aba nova):** toda vez que uma venda sai do
  estoque, o app agora registra automaticamente essa **saída** — sem nenhum
  passo extra e sem duplicar nada. Também dá pra registrar **entradas**
  manuais (compra de fornecedor etc.) pelo botão **"+ Registrar entrada"**.
  - Cada movimentação guarda: data/hora, tipo (entrada/saída), produto,
    quantidade, localidade, usuário responsável, motivo, pedido relacionado
    (quando a saída vem de uma venda) e observação.
  - Filtros: período (Hoje/Ontem/Semana/Mês/Personalizado/Todos), produto,
    usuário, localidade e tipo.
  - **Relatório de entradas por usuário** — mostra quantas entradas e
    quantos pacotes cada pessoa registrou no período, com total geral.
  - **Entrada × Saída × Estoque** — ao filtrar por um produto específico, o
    app mostra o estoque calculado no início do período, quanto entrou,
    quanto saiu e o estoque atual (esse último sempre em tempo real, vindo
    direto do cadastro do produto — o "início do período" é calculado a
    partir dele, não é uma foto salva do passado).
  - Se você apagar um pedido (na aba Pedidos), a saída de estoque
    correspondente também é removida do histórico — para o relatório nunca
    mostrar um movimento "fantasma" de uma venda que não existe mais.
  - Os botões rápidos de **+ / −** na aba Estoque (que já existiam) também
    passaram a gerar uma movimentação simples ("Ajuste rápido"), pra nada
    ficar de fora do histórico.
- **Pedidos virou a tela central de vendas.** A antiga aba "Vendas" foi
  removida — agora tudo acontece em **Pedidos**:
  - Botão **"+ Novo Pedido"** abre o formulário de venda (cliente, vendedor,
    localidade do estoque, itens, desconto, forma de pagamento) — é o mesmo
    fluxo de antes, só que num formulário que abre por cima da lista de
    pedidos, em vez de numa aba separada.
  - Dentro do formulário, o botão **"+ Novo"** ao lado do campo Cliente abre
    um cadastro rápido (só **nome e telefone**). Ao salvar, o cliente já
    fica selecionado no pedido e os produtos que você já tinha adicionado
    **não se perdem**. Dá pra completar o resto do cadastro (cidade,
    aniversário) depois, na aba Clientes, quando sobrar um tempo.
  - Cada pedido mostra **Pagamento: 🟢 Pago / 🔴 Pendente** e **Entrega: 🟢
    Entregue / 🔴 Pendente**, dois controles independentes.
  - Pagamento à vista (Pix/Dinheiro/Cartão) já nasce **pago**. Pagamento **à
    prazo** usa exatamente a mesma estrutura de **Contas a Receber** de
    sempre — nada foi duplicado. O botão **"Quitar pagamento"** dentro do
    pedido abre o mesmo registro de pagamento da aba A Receber.
  - Filtros combináveis: Pagamento (Todos/Pagos/Pendentes) + Entrega
    (Todos/Entregues/Pendentes) — dá pra ver, por exemplo, só quem já
    recebeu o café mas ainda não pagou.
  - A aba **A Receber** continua existindo à parte, como uma visão
    consolidada por cliente (quanto cada um deve no total) — útil pra uma
    visão geral, mas o dia a dia de "quitar" um pedido específico agora é
    feito direto em Pedidos, sem precisar trocar de tela.
- **Previsão de recompra (aba "Recompras"):** o app estuda o histórico de
  compras de cada cliente **por produto** e estima quando ele deve comprar
  de novo, para você entrar em contato **antes** de acabar.
  - A previsão é feita **produto por produto**. Um mesmo cliente que compra
    Café 250 g e Café 500 g tem uma previsão para cada embalagem — elas nunca
    se misturam.
  - O cálculo usa o **intervalo médio** entre as últimas compras daquele
    produto (últimas 3 a 6). A **próxima compra prevista** = data da última
    compra + intervalo médio. A **data sugerida de contato** é alguns dias
    antes disso (por padrão 7 dias; dá para mudar).
  - Cada previsão tem um **status por cor**: 🟢 recente, 🟡 próxima,
    🟠 acabando e 🔴 atrasada.
  - Tem também um **indicador de confiança** (Alta / Média / Baixa) que olha
    se o cliente compra em intervalos regulares — quanto mais regular, mais
    confiável a previsão. Cliente com **uma única compra** não gera previsão
    (ainda não há padrão).
  - Na **ficha do cliente** (clique no cliente na aba Clientes) aparece a
    seção **"🔮 Previsão de Recompra"** com última compra, produto, quantidade
    média, intervalo médio, próxima compra, data de contato, status, confiança
    e quantas compras foram usadas no cálculo.
  - A aba **Recompras** reúne todos os clientes que estão para comprar, com
    filtros por período (Hoje / 3 / 7 / 15 dias / Atrasados / Todos), por
    cliente, por produto e por status.
  - Dá pra **registrar um contato** (data, responsável e observação) direto
    no cliente. Isso fica no histórico e **não altera** a previsão — a
    previsão só muda quando houver uma nova venda de verdade.
  - As previsões são **recalculadas automaticamente** a cada nova venda.
- **Contas a receber:** toda venda registrada com forma de pagamento **"À
  prazo"** gera automaticamente um lançamento na nova aba **A Receber**, com
  o valor total daquela venda. Nessa aba dá pra ver quanto cada cliente
  deve, quanto já foi pago e o saldo restante, e registrar pagamentos
  (inclusive parciais) clicando no card do cliente.
- **Ranking de clientes** na aba Resumo, mostrando quem mais comprou no mês.
- Ícones de editar/excluir (o lápis ✎ e a lixeira 🗑) ficaram maiores e mais
  fáceis de tocar no celular.


- **Estoque separado por localidade:** cada produto tem quantidade em **Manhuaçu**
  e em **BH**, controladas de forma independente. Ao registrar uma venda você
  escolhe de qual estoque o item está saindo.
- **Custo do produto e cálculo de lucro:** ao cadastrar/editar um produto você
  pode informar o **custo**. O app mostra, em tempo real, o **lucro**, a
  **margem (%)** e o **markup (%)** enquanto você digita.
- **Forma de pagamento na venda:** Pix, Dinheiro, Cartão ou À prazo.
- **Desconto na venda:** informe um desconto em R$ e veja o subtotal, o desconto
  e o total final antes de registrar.
- **Resumo mais completo:** recebido no mês por forma de pagamento, valor em
  estoque por localidade (Manhuaçu e BH) e lucro estimado do mês (quando há
  custo cadastrado).

## 1. Criar / atualizar o banco de dados (Supabase)

1. Acesse **supabase.com** e crie uma conta gratuita.
2. Clique em **New project**. Dê um nome (ex.: "cafe-estoque"), crie uma senha
   (guarde ela, mas não vai precisar usar depois) e escolha uma região perto do
   Brasil (ex.: South America). Clique em **Create new project** e espere
   uns 2 minutos ele ficar pronto.
3. No menu da esquerda, clique em **SQL Editor** → **New query**.
4. Abra o arquivo `supabase-schema.sql` (está nesta pasta), copie todo o
   conteúdo, cole no editor do Supabase e clique em **Run**.

   > **Importante:** o `supabase-schema.sql` agora serve para os dois casos:
   > - **Projeto novo:** ele cria as tabelas já com todas as colunas.
   > - **Você já usava a versão anterior do app:** ele também faz a
   >   **migração**, adicionando as colunas novas (custo, estoque por
   >   localidade, forma de pagamento, desconto, etc.) **sem apagar** os dados
   >   que você já tinha. Pode rodar o script sem medo — ele é seguro para
   >   rodar mais de uma vez.

5. No menu da esquerda, clique em **Project Settings** (ícone de engrenagem)
   → **API**. Você vai ver dois valores:
   - **Project URL** (algo como `https://xxxx.supabase.co`)
   - **anon public** key (uma chave longa)

### Novos campos criados pelo script

- Na tabela **products**: `cost` (custo), `qty_mhu` (estoque em Manhuaçu) e
  `qty_bh` (estoque em BH).
- Na tabela **sales**: `payment_method` (forma de pagamento), `discount`
  (desconto em R$), `location` (de qual estoque saiu), `cost_at_sale` (custo
  do produto no momento da venda, usado para estimar o lucro), `client_id`/
  `client_name` (cliente da venda), `seller_id`/`seller_name` (vendedor) e
  `sale_group_id` (agrupa itens vendidos juntos no mesmo carrinho).
- Tabelas novas: **clients** (cadastro de clientes, com aniversário) e
  **sellers** (cadastro de vendedores).
- Tabela nova **recompra_contacts**: guarda os contatos que você registra na
  previsão de recompra (data, responsável e observação). Se você já usava uma
  versão anterior do app, **rode o `supabase-schema.sql` novamente** para criar
  essa tabela — sem isso, a aba Recompras funciona normalmente, mas o botão
  "Registrar contato" não terá onde salvar. É seguro rodar o script de novo.

- Tabela nova **order_deliveries**: guarda só o status de entrega de cada
  pedido (usada pela aba Pedidos). Não duplica vendas nem mexe em estoque.
- Na tabela **stock_entries** (já existia, mas agora é usada de verdade):
  `movement_type` (entrada/saída), `location`, `order_key` (pedido
  relacionado, quando a saída vem de uma venda), `reason` (motivo),
  `transfer_group_id` e `related_location` (protocolo e localidade "do outro
  lado" de uma transferência). É o que alimenta a aba Movimentações.
- Na tabela **receivable_payments**: `payment_method` (forma de pagamento
  usada em cada quitação — Pix/Dinheiro/Cartão).
- Tabelas novas **cash_registers** e **cash_movements**: o livro-caixa
  completo (aba Caixa). `cash_movements` guarda tipo, valor, descrição,
  caixa, data/hora, usuário, e a origem do lançamento (venda, recebimento,
  transferência ou manual) sem duplicar nada de `sales`/`receivables`.
- Na tabela **products**: `cost_packaging`, `cost_roasting` e
  `cost_stickers` (custo detalhado por componente). A coluna `cost` que já
  existia continua lá — agora ela é sempre a **soma** dos três, pra não
  quebrar nada que já usava o custo total (cálculo de lucro nas vendas,
  Resumo, etc.).

> Se você já usava uma versão antiga do app, rode o `supabase-schema.sql`
> novamente — ele foi atualizado e cria as tabelas/colunas que faltavam. É
> seguro rodar quantas vezes precisar.

> Se você já tinha produtos com estoque na coluna antiga `quantity` e quer
> mover esse saldo para Manhuaçu, o próprio `supabase-schema.sql` traz uma
> linha comentada explicando como fazer isso.

## 2. Configurar o site

1. Abra o arquivo `config.js` (nesta pasta) em qualquer editor de texto
   (Bloco de Notas serve).
2. Substitua:
   ```js
   window.SUPABASE_URL = "COLE_AQUI_A_PROJECT_URL";
   window.SUPABASE_ANON_KEY = "COLE_AQUI_A_ANON_PUBLIC_KEY";
   ```
   pelos valores que você copiou no passo anterior. Salve o arquivo.

## 3. Publicar o site (Netlify — gratuito)

1. Acesse **app.netlify.com/drop**.
2. Arraste a pasta inteira `cafe-app` (com `index.html`, `app.js`,
   `config.js`) para a área indicada na página.
3. Em poucos segundos o Netlify te dá um link público, algo como
   `https://nome-aleatorio.netlify.app`.
4. Esse é o link do seu app. Envie para o seu irmão em BH — os dois
   acessam o mesmo link e veem os mesmos dados, atualizando em tempo real.

Dica: no Netlify, em **Site settings > Change site name**, você pode trocar
o endereço aleatório por algo como `estoque-cafe.netlify.app`.

## 4. Usar no celular como um app

No navegador do celular (Chrome ou Safari), abra o link e escolha
**Adicionar à tela inicial**. Fica com ícone, abre em tela cheia, como
um aplicativo de verdade.

## Sobre segurança

O app tem uma tela de login simples (usuário `admin`, senha definida no
início do arquivo `app.js`, na constante `LOGIN_PASS`). **Essa senha só
impede que alguém abra o app "sem querer"** — ela fica escrita no código
que roda no navegador, então qualquer pessoa com um pouco de conhecimento
técnico consegue ver o código-fonte da página e descobrir a senha, ou
simplesmente acessar o banco de dados direto pela chave `anon` do
`config.js`. Não é uma proteção real contra alguém que queira acessar os
dados de propósito.

Na prática, isso continua sendo um app privado de uso familiar: o link e a
senha não devem ser compartilhados publicamente. Se um dia quiser uma
segurança de verdade (login com conta própria para cada pessoa, senhas
com hash, etc.), dá para evoluir o projeto usando o sistema de
autenticação do Supabase — é só pedir.
