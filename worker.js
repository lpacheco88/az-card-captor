// worker.js — AZ Card Captor (captura INCREMENTAL de cards "Back" do Azure DevOps)
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
const authHeader = `Basic ${Buffer.from(`:${AZURE_DEVOPS_PAT}`).toString('base64')}`;

const axiosInstance = axios.create({
    headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
    }
});

// --- Filtros e utilidades ---

// Captura apenas Task Codes de backend ("Back ..."), excluindo Front e Front/Back.
function isBackTask(fields) {
    const type = fields['System.WorkItemType'] || '';
    const title = (fields['System.Title'] || '').trim();
    return type === 'Task Code' && /^back\b/i.test(title) && !/front/i.test(title);
}

function sanitizeFilename(title) {
    return title
        .replace(/[\\/*?:"<>|]/g, "") // Remove caracteres inválidos
        .replace(/\s+/g, "_")         // Substitui espaços por underscore
        .toLowerCase();
}

// IDs já capturados localmente (extraídos dos nomes de arquivo *_<id>_*).
async function getExistingIds() {
    try {
        const files = await fs.readdir(OUTPUT_DIR);
        const ids = new Set();
        for (const f of files) {
            if (!f.endsWith('.md')) continue;
            const m = f.match(/_(\d+)_/);
            if (m) ids.add(parseInt(m[1], 10));
        }
        return ids;
    } catch {
        return new Set();
    }
}

// --- Fase 1: Extração (Read) ---

async function getTasksFromEpic(epicId) {
    console.log(`🔎 Buscando TODA a hierarquia do Epic ID: ${epicId}...`);
    const url = `${BASE_URL}/wit/wiql?api-version=${API_VERSION}`;
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
    const allIds = new Set();
    relations.forEach(rel => {
        if (rel.source && rel.source.id) allIds.add(rel.source.id);
        if (rel.target && rel.target.id) allIds.add(rel.target.id);
    });
    allIds.delete(epicId); // Remove o próprio Epic
    console.log(`📦 Total de work items encontrados: ${allIds.size}`);
    return Array.from(allIds);
}

async function getWorkItemDetails(taskIds) {
    if (taskIds.length === 0) return [];
    const batchSize = 200;
    const allDetails = [];
    for (let i = 0; i < taskIds.length; i += batchSize) {
        const batch = taskIds.slice(i, i + batchSize);
        const fields = 'System.Id,System.Title,System.WorkItemType,System.State,System.Description,Microsoft.VSTS.Common.AcceptanceCriteria,System.Parent';
        const url = `${BASE_URL}/wit/workitems?ids=${batch.join(',')}&fields=${fields}&api-version=${API_VERSION}`;
        const response = await axiosInstance.get(url);
        allDetails.push(...(response.data.value || []));
    }
    return allDetails;
}

// --- Fase 2: Geração INCREMENTAL de arquivos (Write) ---

async function generateTaskCodeFiles(tasks) {
    if (tasks.length === 0) {
        console.log('✅ Nenhum card novo (Back) para gerar.');
        return;
    }
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    for (const task of tasks) {
        const fields = task.fields;
        const taskId = fields['System.Id'];
        const workItemType = fields['System.WorkItemType'] || 'Task';
        const title = fields['System.Title'] || 'Sem Titulo';
        const description = fields['System.Description'] || 'Sem descrição';
        const acceptance = fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '';
        const state = fields['System.State'] || 'New';

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
        console.log(`  ✅ Novo card gerado: ${filename}`);
    }
}

// --- Fase 3: Marcação no Azure (somente cards NOVOS, com merge de tags) ---

async function getCurrentTags(workItemId) {
    try {
        const url = `${BASE_URL}/wit/workitems/${workItemId}?fields=System.Tags&api-version=${API_VERSION}`;
        const resp = await axiosInstance.get(url);
        const raw = (resp.data.fields && resp.data.fields['System.Tags']) || '';
        return raw.split(';').map(t => t.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

async function markCapturedInAzure(tasks) {
    for (const task of tasks) {
        const taskId = task.fields['System.Id'];
        const url = `${BASE_URL}/wit/workitems/${taskId}?api-version=${API_VERSION}`;
        const currentTags = await getCurrentTags(taskId);
        const mergedTags = Array.from(new Set([...currentTags, 'Capturado-Local'])).join('; ');
        const patchData = [
            { op: 'add', path: '/fields/System.Tags', value: mergedTags },
            { op: 'add', path: '/fields/System.History', value: '🤖 Worker: card novo capturado localmente para revisão do agente.' }
        ];
        try {
            await axiosInstance.patch(url, patchData, {
                headers: { 'Content-Type': 'application/json-patch+json' }
            });
            console.log(`  🔄 Card ${taskId} marcado como capturado.`);
        } catch (error) {
            console.error(`  ❌ Erro ao marcar card ${taskId}:`, error.response?.data?.message || error.message);
        }
    }
}

// --- Execução Principal ---

async function main() {
    try {
        console.log('🚀 Iniciando AZ Card Captor (incremental, apenas Back)...\n');

        const taskIds = await getTasksFromEpic(TARGET_EPIC_ID);
        if (taskIds.length === 0) {
            console.log('⚠️ Nenhum work item encontrado no Epic. Encerrando.');
            return;
        }

        const [details, existing] = await Promise.all([
            getWorkItemDetails(taskIds),
            getExistingIds()
        ]);

        const backTasks = details.filter(t => isBackTask(t.fields || {}));
        const newTasks = backTasks.filter(t => !existing.has(t.fields['System.Id']));

        console.log(`\n📊 Back candidatos: ${backTasks.length} | já capturados: ${backTasks.length - newTasks.length} | novos: ${newTasks.length}\n`);

        await generateTaskCodeFiles(newTasks);
        await markCapturedInAzure(newTasks);

        console.log('\n✨ Captura incremental concluída!');
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
