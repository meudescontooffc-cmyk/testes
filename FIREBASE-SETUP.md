# Colocando o sistema no ar com Firebase

## 1. Criar o projeto
1. Acesse https://console.firebase.google.com
2. "Criar projeto" → dê um nome (ex: granja-m-santos) → pode desativar o Google Analytics, não é necessário.

## 2. Ativar o banco de dados
1. No menu lateral: **Build > Firestore Database**
2. "Criar banco de dados" → modo **produção** → escolha a região `southamerica-east1` (São Paulo) se disponível.

## 3. Ativar o login
1. No menu lateral: **Build > Authentication**
2. Aba "Sign-in method" → clique em **E-mail/senha** → ative → salvar.

## 4. Pegar as chaves do projeto
1. Clique no ícone de engrenagem (⚙) ao lado de "Visão geral do projeto" → **Configurações do projeto**
2. Role até "Seus apps" → clique no ícone **</>** (Web)
3. Dê um apelido (ex: painel-vendas) → "Registrar app"
4. Copie o objeto `firebaseConfig` que aparece na tela.

## 5. Colar no sistema
Abra o arquivo **firebase-config.js** e cole os valores copiados no lugar de cada `"COLE_AQUI..."`.

## 6. Aplicar as regras de segurança
1. Volte em **Firestore Database > aba "Regras"**
2. Apague o que estiver lá e cole todo o conteúdo do arquivo **firestore.rules** (está nesta mesma pasta)
3. Clique em "Publicar"

⚠️ Sem esse passo, qualquer pessoa que descobrir a URL do seu app consegue ler e alterar os dados. Não pule esta etapa.

## 7. Colocar os arquivos no ar
O Firebase Authentication exige que o site seja aberto por `http://` ou `https://` (não funciona abrindo o `index.html` direto por duplo clique, com `file://`). Duas formas simples e gratuitas:

- **Firebase Hosting** (recomendado, já é do mesmo projeto): instale o Node.js, depois no terminal, dentro da pasta do projeto:
  ```
  npm install -g firebase-tools
  firebase login
  firebase init hosting
  firebase deploy
  ```
  Ele vai te dar um link tipo `https://granja-m-santos.web.app` — esse é o link que sua equipe vai usar no celular/computador.

- **Ou, para testar rapidamente**: use a extensão **Live Server** do VS Code (botão direito no `index.html` → "Open with Live Server"). Isso já basta para testar o login e as vendas antes de publicar de vez.

## 8. Primeiro acesso
Ao abrir o sistema pela primeira vez (com as regras já publicadas), em vez da tela de login vai aparecer **"Configuração inicial"** — é ali que você cria a conta do proprietário. Depois disso, use a área de **Usuários** dentro do sistema para cadastrar os funcionários.
