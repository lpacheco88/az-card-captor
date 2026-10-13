# 🚀 AZ Card Captor

Um worker automatizado em Node.js para extrair, documentar e sincronizar Work Items (Epics, Features, User Stories, Tasks e Bugs) do **Azure DevOps**.

Este projeto foi criado para eliminar o trabalho manual de copiar descrições, padronizar a geração de "Task Codes" (esqueletos de implementação) e manter os cards do Azure sempre atualizados com estimativas e documentações geradas por agents/IA.

---

## ✨ Funcionalidades

- 🔍 **Busca Recursiva:** Extrai toda a hierarquia a partir de um Epic (Features ➔ User Stories ➔ Tasks ➔ Bugs).
- 📝 **Geração de Task Codes:** Cria arquivos `.md` estruturados localmente com descrição, critérios de aceite e espaço para implementação.
- 🔄 **Sincronização Bidirecional:** Lê os arquivos `.md` gerados e atualiza automaticamente a Descrição e a Estimativa (Effort/Story Points) nos cards do Azure DevOps.
- 🔒 **Seguro:** Utiliza variáveis de ambiente e Personal Access Tokens (PAT) com escopos restritos.

---

## 📋 Pré-requisitos

- [Node.js](https://nodejs.org/) (v14 ou superior)
- Uma conta no **Azure DevOps** com acesso ao projeto alvo.
- Um **Personal Access Token (PAT)** com permissão de `Read & Write` em *Work Items*.

---

## ⚙️ Instalação e Configuração

1. Clone o repositório:
   ```bash
   git clone https://github.com/lpacheco88/az-card-captor.git
   cd az-card-captor

2. - Instale as dependências:
    -    npm install
3 - Configure as variáveis de ambiente:
    -    cp .env-exemplo .env
  
🚀 Como Usar
O projeto possui dois scripts principais que podem ser executados independentemente:
1. Extrair e Gerar Arquivos
  Busca os itens no Azure e gera os arquivos .md na pasta de saída configurada.
  bash:
    node worker.js
2. Atualizar Cards no Azure
Lê os arquivos .md da pasta de saída e envia as descrições e estimativas de volta para o Azure DevOps.
node update_worker.js

💡 Dica: Para que a estimativa seja sincronizada, adicione a linha **Estimativa:** 5 (ou o valor desejado) no topo do arquivo .md gerado.


🔐 Como configurar o .env
Variável
Descrição
Exemplo
AZURE_DEVOPS_ORG
Nome da sua organização no Azure (na URL).
Trizy
AZURE_DEVOPS_PROJECT
Nome do projeto dentro da organização.
Squad Varejo
AZURE_DEVOPS_PAT
Seu Personal Access Token. Deve ter escopo Work Items: Read & write.
abc123xyz...
TARGET_EPIC_ID
O ID numérico do Epic que será a raiz da busca.
105346
OUTPUT_DIR
Pasta local onde os arquivos .md serão salvos.
./generated_task_codes

📂 Estrutura do Projeto
az-card-captor/
├── .env-exemplo             # Modelo seguro de variáveis de ambiente
├── .gitignore               # Garante que .env e node_modules não sejam versionados
├── package.json             # Dependências do projeto (axios, dotenv)
├── worker.js                # Script principal de extração e geração
├── update_worker.js         # Script de sincronização (Azure ← Local)
└── generated_task_codes/    # Pasta gerada automaticamente com os arquivos .md

⚠️ Notas de Segurança
Nunca faça commit do arquivo .env real. Ele já está protegido pelo .gitignore.
Rotacione seu PAT no Azure DevOps a cada 90 dias por boas práticas de segurança.
Se o token for comprometido, revogue-o imediatamente em: Azure DevOps ➔ User Settings ➔ Personal access tokens.


🤝 Contribuição
Sinta-se à vontade para abrir Issues ou Pull Requests para melhorar este worker!
Autor: lpacheco88


---

### Passo 2: Subir o README para o GitHub

Agora, adicione o novo arquivo ao Git e faça o push com os seguintes comandos:

```bash
# 1. Adiciona o README ao staging area
git add README.md

# 2. Faz o commit
git commit -m "docs: adiciona README.md com instruções de instalação e uso"

# 3. Envia para o GitHub
git push origin main
