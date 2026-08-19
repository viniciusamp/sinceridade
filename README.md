# Estoque & Vendas — passo a passo

Este é um site pronto. Você só precisa: (1) criar o banco de dados no Supabase,
(2) colar duas informações no arquivo `config.js`, e (3) publicar a pasta.
Leva uns 10 minutos, sem precisar programar.

## Novidades desta versão

- **Pedidos (status de entrega e pagamento):** nova aba **Pedidos**, que
  mostra cada venda já registrada (agrupada por carrinho, do jeito que ela
  foi feita na aba Vendas) com dois status:
  - **Entrega:** pendente ou entregue — marque **"Confirmar entrega"** quando
    o cliente retirar/receber o pedido (guarda quem confirmou e uma
    observação opcional). Isso é só um controle de acompanhamento — **o
    estoque continua saindo no momento da venda**, como já funcionava antes;
    marcar a entrega não mexe em estoque nem duplica nada.
  - **Pagamento:** vendas à vista (Pix/Dinheiro/Cartão) aparecem
    automaticamente como pagas. Vendas **à prazo** mostram o mesmo status
    da aba **A Receber** (Em aberto / Parcial / Pago), e o botão **"Registrar
    pagamento"** abre o mesmo fluxo de lá — não existe um controle de
    pagamento duplicado, é a mesma informação vista de outro ângulo.
  - Filtros rápidos: Todos, Entrega pendente, Entregues, Pagamento pendente.
- **Previsão de recompra (nova aba "Recompras"):** o app agora estuda o
  histórico de compras de cada cliente **por produto** e estima quando ele
  deve comprar de novo, para você entrar em contato **antes** de acabar.
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
