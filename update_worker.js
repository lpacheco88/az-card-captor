// update_worker.js
require('dotenv').config();
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// --- Configurações e Autenticação ---
const { 
    AZURE_DEVOPS_ORG, 
    AZURE_DEVOPS_PROJECT, 
    AZURE_DEVOPS_PAT, 
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

// --- Funções Auxiliares de Parse ---

function extractIdFromFilename(filename) {
    // Ex: feature_105341_calculo_data.md -> 105341
    const match = filename.match(/_(\d+)_/);
    return match ? parseInt(match[1], 10) : null;
}

function extractEstimate(content) {
    // Busca por "**Estimativa:** 8" ou "Effort: 8"
    const match = content.match(/\*\*Estimativa:\*\*\s*(\d+)|Effort:\s*(\d+)/i);
    return match ? parseInt(match[1] || match[2], 10) : null;
}

function extractDescription(content) {
    // Extrai tudo entre "##  Descrição" e o próximo "##"
    const match = content.match(/##\s*📝\s*Descrição\s*\n([\s\S]*?)(?=\n##|\Z)/i);
    return match ? match[1].trim() : null;
}

function extractStatus(content) {
    // Busca por "**Status:** Done"
    const match = content.match(/\*\*Status:\*\*\s*([A-Za-z]+)/i);
    return match ? match[1].trim() : null;
}

function extractWorkedHours(content) {
    // Busca por "**Horas Trabalhadas:** 8" (aceita vírgula decimal)
    const match = content.match(/\*\*Horas Trabalhadas:\*\*\s*(\d+(?:[.,]\d+)?)/i);
    return match ? parseFloat(match[1].replace(",", ".")) : null;
}

// Tags aplicadas a todo card revisado pelo agente (merge com as existentes).
const AGENT_TAGS = ['Agente-Revisado', 'Code-Validado'];

async function getCurrentTags(workItemId) {
    try {
        const url = `${BASE_URL}/wit/workitems/${workItemId}?fields=System.Tags&api-version=${API_VERSION}`;
        const resp = await axiosInstance.get(url);
        const raw = (resp.data.fields && resp.data.fields['System.Tags']) || '';
        return raw.split(';').map(t => t.trim()).filter(Boolean);
    } catch (error) {
        console.warn(`  ⚠️ Não foi possível ler as tags do card ${workItemId}: ${error.message}`);
        return [];
    }
}

function mergeTags(existing, added) {
    const set = new Set(existing);
    for (const t of added) set.add(t);
    return Array.from(set).join('; ');
}

// Mapa de status do card -> estado válido do processo deste projeto (Azure DevOps).
// O processo "Task Code" usa estados em pt-BR: o terminal é "Concluído".
const STATE_MAP = {
    Done: 'Concluído',
    Closed: 'Concluído',
    'Concluído': 'Concluído',
    Active: 'Codificação',
    New: 'Não iniciado',
};
const VALID_STATES = [
    'Não iniciado',
    'Estacionado',
    'Retorno para especificação',
    'Codificação',
    'Code review',
    'Concluído',
    'Cancelado',
];

// --- Função Principal de Atualização ---

async function updateWorkItem(workItemId, description, estimate, status, workedHours) {
    const url = `${BASE_URL}/wit/workitems/${workItemId}?api-version=${API_VERSION}`;
    const patchData = [];

    if (description) {
        patchData.push({ op: 'add', path: '/fields/System.Description', value: description });
    }

    if (estimate) {
        // O campo de estimativa varia conforme o tipo (Effort para Features/Bugs, StoryPoints para User Stories)
        // Vamos tentar atualizar ambos para garantir
        patchData.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: estimate });
        patchData.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: estimate });
    }

    // Atualiza Status se o agente marcou como concluído (traduzido para o estado do processo)
    const resolvedStatus = status ? STATE_MAP[status] || status : null;
    const statusApplied = resolvedStatus && VALID_STATES.includes(resolvedStatus);
    if (statusApplied) {
        patchData.push({ op: 'add', path: '/fields/System.State', value: resolvedStatus });
    }

    // Atualiza Horas Trabalhadas (Completed Work)
    if (workedHours !== null && workedHours !== undefined) {
        patchData.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: workedHours });
    }

    // Tags de revisão do agente (merge com as tags já existentes no card)
    const currentTags = await getCurrentTags(workItemId);
    patchData.push({ op: 'add', path: '/fields/System.Tags', value: mergeTags(currentTags, AGENT_TAGS) });

    // Histórico de revisão do agente (uma entrada por execução)
    const hoursPart = (workedHours !== null && workedHours !== undefined) ? ` e ${workedHours}h registradas` : '';
    const historyValue = statusApplied
        ? `🤖 Agente: card revisado, código validado na branch, status sincronizado para "${resolvedStatus}"${hoursPart}.`
        : `🤖 Agente: card revisado contra o código da branch; pendências registradas no card local (não marcado como concluído)${hoursPart}.`;
    patchData.push({ op: 'add', path: '/fields/System.History', value: historyValue });

    if (patchData.length === 0) {
        console.log(`  ⚠️ Nenhum dado para atualizar no card ${workItemId}`);
        return;
    }

    try {
        await axiosInstance.patch(url, patchData, {
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json-patch+json'
            }
        });
        console.log(`  ✅ Card ${workItemId} atualizado (Desc: ${description ? 'Sim' : 'Não'}, Est: ${estimate || 'N/A'}, Estado: ${statusApplied ? resolvedStatus : 'mantido'}, Horas: ${workedHours ?? 'N/A'}, Tags: ${AGENT_TAGS.join(', ')})`);
    } catch (error) {
        console.error(`   Erro ao atualizar card ${workItemId}:`, error.response?.data?.message || error.message);
    }
}

// --- Execução Principal ---

async function main() {
    try {
        console.log('🚀 Iniciando Worker de Atualização de Descrições e Estimativas...\n');
        
        // Lê todos os arquivos .md da pasta
        const files = await fs.readdir(OUTPUT_DIR);
        const mdFiles = files.filter(f => f.endsWith('.md'));
        
        console.log(`📂 Encontrados ${mdFiles.length} arquivos para processar.\n`);

        for (const file of mdFiles) {
            const filepath = path.join(OUTPUT_DIR, file);
            const content = await fs.readFile(filepath, 'utf-8');
            
            const workItemId = extractIdFromFilename(file);
            const estimate = extractEstimate(content);
            const description = extractDescription(content);
            const status = extractStatus(content);
            const workedHours = extractWorkedHours(content);

            if (!workItemId) {
                console.log(`  ⚠️ Arquivo ignorado (ID não encontrado): ${file}`);
                continue;
            }

            console.log(`🔄 Processando: ${file} (ID: ${workItemId})`);
            await updateWorkItem(workItemId, description, estimate, status, workedHours);
        }
        
        console.log('\n✨ Processo de atualização concluído!');
        
    } catch (error) {
        console.error('\n💥 Erro fatal no Worker:');
        console.error(error.message);
        process.exit(1);
    }
}

main();