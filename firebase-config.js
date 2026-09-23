/* ============================================================
   CONFIGURAÇÃO DO FIREBASE — Granja M Santos
   ============================================================
   PASSO A PASSO:

   1. Acesse https://console.firebase.google.com e crie um projeto
      (é gratuito no plano "Spark", suficiente para começar).

   2. No menu lateral: Build > Firestore Database > "Criar banco de dados"
      → escolha o modo "produção" e a região mais próxima (ex: southamerica-east1).

   3. No menu lateral: Build > Authentication > aba "Sign-in method"
      → ative o provedor "E-mail/senha".

   4. Clique no ícone de engrenagem (⚙) > "Configurações do projeto"
      → role até "Seus apps" > clique no ícone </> (Web)
      → dê um nome (ex: "painel-vendas") > "Registrar app"
      → copie o objeto "firebaseConfig" que aparece na tela.

   5. Cole os valores copiados nos campos abaixo, no lugar de "COLE_AQUI...".

   6. Depois de configurar, vá até o arquivo "firestore.rules" (nesta mesma
      pasta) e cole o conteúdo dele em Firestore Database > aba "Regras"
      no console do Firebase, substituindo o que já estiver lá. Sem isso,
      qualquer pessoa que descobrir seu projeto pode ler/escrever os dados.
   ============================================================ */

export const firebaseConfig = {
  apiKey: "AIzaSyAEcufys2Gt_iXimve59urgOpiP9PYsmGQ",
  authDomain: "sistema-do-marlos.firebaseapp.com",
  projectId: "sistema-do-marlos",
  storageBucket: "sistema-do-marlos.firebasestorage.app",
  messagingSenderId: "242140983070",
  appId: "1:242140983070:web:7986c4f946d1ba204ae30f",
};

// O Firebase Authentication exige um formato de e-mail para login.
// Como o sistema usa "usuário" (sem @), transformamos o usuário em um
// e-mail interno usando este domínio — ele não precisa existir de verdade,
// o Marlos digita só o nome de usuário e a senha normalmente na tela de login.
export const AUTH_EMAIL_DOMAIN = "sistemadomarlos.local";

/* ---------------- Não precisa mexer daqui para baixo ---------------- */

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence, getAuth as getAuthNamed,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});
// "browserLocalPersistence" é o que faz a pessoa continuar logada
// mesmo depois de fechar e reabrir o navegador.

// Cache local com persistência real em disco (IndexedDB) — é isso que
// permite o funcionário continuar vendendo mesmo sem internet: os dados
// ficam guardados no aparelho e sincronizam sozinhos quando a conexão volta.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// Uma segunda instância do Firebase, usada só no momento em que o dono
// cria a conta de um novo funcionário — sem isso, criar outra conta
// derrubaria a sessão de quem está logado no momento.
export function getSecondaryAuthInstance() {
  const secondaryApp = initializeApp(firebaseConfig, "secondary-" + Date.now());
  const secondaryAuth = getAuthNamed(secondaryApp);
  return { secondaryApp, secondaryAuth, cleanup: () => deleteApp(secondaryApp) };
}
