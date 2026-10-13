// worker.js
require('dotenv').config();
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// --- Configurações e Autenticação ---
const { 
    AZURE_DEVOPS_ORG, 
    AZURE_DEVOPS_PROJECT, 
    AZURE_DEVOPS_PAT, 
    TARGET_EPIC_ID, 
    OUTPUT_DIR 
} = process.env;

const BASE_URL = `https://dev.azure.com/${AZURE_DEVOPS_ORG}/${AZURE_DEVOPS_PROJECT}/_apis`;
const API_VERSION = '7.0';

// Autenticação Basic usando o PAT (o usuário é vazio)
const authHeader = `Basic ${Buffer.from(`:${AZURE_DEVOPS_PAT}`).toString('base64')}`;

const axiosInstance = axios.create({
    headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
    }
});

// --- Funções Auxiliares ---

function sanitizeFilename(title) {
    return title
        .replace(/[\\/*?:"<>|]/g, "") // Remove caracteres inválidos
        .replace(/\s+/g, "_")         // Substitui espaços por underscore
        .toLowerCase();
}

// --- Fase 1: Extração (Read) ---

async function getTasksFromEpic(epicId) {
    console.log(` Buscando TODA a hierarquia do Epic ID: ${epicId}...`);
    
    const url = `${BASE_URL}/wit/wiql?api-version=${API_VERSION}`;
    
    // Query que busca TODOS os descendentes (Features, User Stories, Tasks, Bugs)
    const wiqlQuery = {
        query: `
            SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State]
            FROM WorkItemLinks
            WHERE (
                [Source].[System.Id] = ${epicId} 
                AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
            )
            MODE (Recursive)
        `
    };

    const response = await axiosInstance.post(url, wiqlQuery);
    const relations = response.data.workItemRelations || [];
    
    console.log(`📋 Encontradas ${relations.length} relações na hierarquia`);
    
    // Extrai todos os IDs únicos (source e target)
    const allIds = new Set();
    relations.forEach(rel => {
        if (rel.source && rel.source.id) allIds.add(rel.source.id);
        if (rel.target && rel.target.id) allIds.add(rel.target.id);
    });
    
    // Remove o próprio Epic da lista
    allIds.delete(epicId);
    
    console.log(`📦 Total de work items encontrados: ${allIds.size}`);
    
    return Array.from(allIds);
}

async function getWorkItemDetails(taskIds) {
    if (taskIds.length === 0) return [];
    
    console.log(` Buscando detalhes de ${taskIds.length} work items...`);
    
    // Busca em lotes de 200 (limite da API do Azure)
    const batchSize = 200;
    const allDetails = [];
    
    for (let i = 0; i < taskIds.length; i += batchSize) {
        const batch = taskIds.slice(i, i + batchSize);
        const idsStr = batch.join(',');
        const fields = 'System.Id,System.Title,System.WorkItemType,System.State,System.Description,Microsoft.VSTS.Common.AcceptanceCriteria,System.Parent';
        const url = `${BASE_URL}/wit/workitems?ids=${idsStr}&fields=${fields}&api-version=${API_VERSION}`;
        
        const response = await axiosInstance.get(url);
        const items = response.data.value || [];
        allDetails.push(...items);
        
        console.log(`  ✅ Buscados ${items.length} itens (lote ${Math.floor(i/batchSize) + 1})`);
    }
    
    return allDetails;
}

async function generateTaskCodeFiles(tasks) {
    console.log(`📂 Gerando arquivos na pasta: ${OUTPUT_DIR}`);
    
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    
    // Organiza por tipo para melhor visualização
    const groupedByType = {};
    
    for (const task of tasks) {
        const fields = task.fields;
        const taskId = fields['System.Id'];
        const workItemType = fields['System.WorkItemType'] || 'Task';
        const title = fields['System.Title'] || 'Sem Titulo';
        const description = fields['System.Description'] || 'Sem descrição';
        const acceptance = fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '';
        const state = fields['System.State'] || 'New';
        const parentId = fields['System.Parent'] || 'N/A';

        // Agrupa por tipo
        if (!groupedByType[workItemType]) {
            groupedByType[workItemType] = [];
        }
        groupedByType[workItemType].push({
            taskId,
            title,
            description,
            acceptance,
            state,
            parentId
        });
    }

    // Gera arquivos para cada tipo
    for (const [type, items] of Object.entries(groupedByType)) {
        console.log(`\n Gerando ${items.length} arquivo(s) de ${type}:`);
        
        for (const item of items) {
            const filename = `${type.toLowerCase().replace(/\s/g, '_')}_${item.taskId}_${sanitizeFilename(item.title)}.md`;
            const filepath = path.join(OUTPUT_DIR, filename);
            
            const content = `# ${type} ${item.taskId}: ${item.title}

**Estado:** ${item.state}
**ID:** ${item.taskId}
**Parent ID:** ${item.parentId}

## 📝 Descrição
${item.description}

## ✅ Critérios de Aceite
${item.acceptance}

## 💻 Task Code
\`\`\`javascript
// TODO: Implementar ${type} ${item.taskId}
// ${item.title}

async function execute() {
    // Sua implementação aqui
}
\`\`\`

## 🔗 Hierarquia
- **Parent:** Work Item #${item.parentId}
- **Tipo:** ${type}
`;
            
            await fs.writeFile(filepath, content, 'utf-8');
            console.log(`  ✅ ${filename}`);
        }
    }
    
    console.log(`\n📊 Resumo:`);
    for (const [type, items] of Object.entries(groupedByType)) {
        console.log(`   - ${type}: ${items.length} arquivo(s)`);
    }
}

// --- Fase 2: Geração de Arquivos (Write) ---

async function generateTaskCodeFiles(tasks) {
    console.log(`📂 Gerando arquivos na pasta: ${OUTPUT_DIR}`);
    
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    
    for (const task of tasks) {
        const fields = task.fields;
        const taskId = fields['System.Id'];
        const workItemType = fields['System.WorkItemType'] || 'Task';
        const title = fields['System.Title'] || 'Sem Titulo';
        const description = fields['System.Description'] || 'Sem descrição';
        const acceptance = fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '';
        const state = fields['System.State'] || 'New';

        // Nome do arquivo agora inclui o tipo do work item
        const filename = `${workItemType.toLowerCase().replace(/\s/g, '_')}_${taskId}_${sanitizeFilename(title)}.md`;
        const filepath = path.join(OUTPUT_DIR, filename);
        
        const content = `# ${workItemType} ${taskId}: ${title}

**Estado:** ${state}
**ID:** ${taskId}

## 📝 Descrição
${description}

## ✅ Critérios de Aceite
${acceptance}

## 💻 Task Code
\`\`\`javascript
// TODO: Implementar ${workItemType} ${taskId}
// ${title}

async function execute() {
    // Sua implementação aqui
}
\`\`\`
`;
        
        await fs.writeFile(filepath, content, 'utf-8');
        console.log(`  ✅ Gerado: ${filename} (${workItemType})`);
    }
}

// --- Fase 3: Atualização dos Cards (Update - Esqueleto) ---

async function updateAzureCards(tasks) {
    console.log(`🔄 Atualizando cards no Azure DevOps...`);
    
    for (const task of tasks) {
        const taskId = task.id;
        const url = `${BASE_URL}/wit/workitems/${taskId}?api-version=${API_VERSION}`;
        
        // JSON Patch para adicionar uma tag e um comentário
        const patchData = [
            {
                op: 'add',
                path: '/fields/System.Tags',
                value: 'Gerado-Automaticamente;Worker-Node-v1'
            },
            {
                op: 'add',
                path: '/fields/System.History',
                value: '🤖 Worker: Arquivo de Task Code gerado com sucesso na pasta local.'
            }
        ];

        try {
            // A API de PATCH do Azure exige application/json-patch+json
            await axiosInstance.patch(url, patchData, {
                headers: { 'Content-Type': 'application/json-patch+json' }
            });
            console.log(`  🔄 Card ${taskId} atualizado.`);
        } catch (error) {
            console.error(`  ❌ Erro ao atualizar card ${taskId}:`, error.response?.data?.message || error.message);
        }
    }
}

// --- Execução Principal ---

async function main() {
    try {
        console.log('🚀 Iniciando Azure DevOps Worker...\n');
        
        // 1. Buscar IDs
        const taskIds = await getTasksFromEpic(TARGET_EPIC_ID);
        if (taskIds.length === 0) {
            console.log("⚠️ Nenhuma Task encontrada neste Epic. Encerrando.");
            return;
        }

        // 2. Buscar Detalhes
        const tasksDetails = await getWorkItemDetails(taskIds);
        
        // 3. Gerar Arquivos
        await generateTaskCodeFiles(tasksDetails);
        
        // 4. Atualizar Cards (Fase 2)
        await updateAzureCards(tasksDetails);
        
        console.log('\n✨ Processo concluído com sucesso!');
        
    } catch (error) {
        console.error('\n💥 Erro fatal no Worker:');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Detalhes:', error.response.data);
        } else {
            console.error(error.message);
        }
        process.exit(1);
    }
}

main();