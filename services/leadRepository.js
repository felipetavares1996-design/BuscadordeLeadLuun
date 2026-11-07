const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEADS_DB_PATH = path.join(DATA_DIR, 'leads.json');

/**
 * Normaliza e valida o schema do objeto Lead antes de persistir ou retornar na API.
 * Garante que `cnpj`, `razaoSocial`, `email` sejam `string | null` e `allPhones` seja um array estruturado.
 *
 * @param {Object} rawLead
 * @returns {Object} Lead normalizado conforme o modelo de domínio
 */
function createLeadModel(rawLead) {
  return {
    id: String(rawLead.id || `lead_${Date.now()}`),
    name: String(rawLead.name || 'Estabelecimento sem nome'),
    cnpj: typeof rawLead.cnpj === 'string' && rawLead.cnpj.trim().length > 0 ? rawLead.cnpj.trim() : null,
    razaoSocial:
      typeof rawLead.razaoSocial === 'string' && rawLead.razaoSocial.trim().length > 0
        ? rawLead.razaoSocial.trim()
        : null,
    socios: Array.isArray(rawLead.socios) ? rawLead.socios : [],
    instagramUrl:
      typeof rawLead.instagramUrl === 'string' && rawLead.instagramUrl.trim().length > 0
        ? rawLead.instagramUrl.trim()
        : null,
    ifoodUrl:
      typeof rawLead.ifoodUrl === 'string' && rawLead.ifoodUrl.trim().length > 0
        ? rawLead.ifoodUrl.trim()
        : null,
    menuPlatform:
      typeof rawLead.menuPlatform === 'string' && rawLead.menuPlatform.trim().length > 0
        ? rawLead.menuPlatform.trim()
        : null,
    email: typeof rawLead.email === 'string' && rawLead.email.trim().length > 0 ? rawLead.email.trim() : null,
    allEmails: Array.isArray(rawLead.allEmails) ? rawLead.allEmails : [],
    phone: String(rawLead.phone || ''),
    waNumber: String(rawLead.waNumber || ''),
    allPhones: Array.isArray(rawLead.allPhones) ? rawLead.allPhones : [],
    address: String(rawLead.address || 'Endereço não informado'),
    rating: typeof rawLead.rating === 'number' ? rawLead.rating : null,
    userRatingCount: typeof rawLead.userRatingCount === 'number' ? rawLead.userRatingCount : 0,
    website: String(rawLead.website || ''),
    mapsUri: String(rawLead.mapsUri || ''),
    isHighOpportunity: Boolean(rawLead.isHighOpportunity),
    opportunityReason: String(rawLead.opportunityReason || ''),
    badgeColor: String(rawLead.badgeColor || 'emerald'),
    pitchMessage: String(rawLead.pitchMessage || ''),
    status: String(rawLead.status || 'pending'),
    notes: String(rawLead.notes || ''),
    lastContactedAt: rawLead.lastContactedAt || null,
    updatedAt: new Date().toISOString()
  };
}

/**
 * Garante a existência do diretório e do arquivo de persistência local (`data/leads.json`).
 */
function ensureDatabaseExists() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(LEADS_DB_PATH)) {
    fs.writeFileSync(LEADS_DB_PATH, JSON.stringify({ leads: [], lastUpdated: null }, null, 2), 'utf8');
  }
}

/**
 * Carrega todos os leads persistidos no banco local JSON.
 * @returns {Array<Object>}
 */
function getAllLeads() {
  try {
    ensureDatabaseExists();
    const raw = fs.readFileSync(LEADS_DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.leads) ? parsed.leads : [];
  } catch (error) {
    console.warn(`[LeadRepository] Falha ao ler persistência local: ${error.message}`);
    return [];
  }
}

/**
 * Persiste (upsert por `id`) uma lista de leads capturados e enriquecidos.
 * Nunca interrompe o fluxo principal caso ocorra falha de I/O.
 *
 * @param {Array<Object>} leads
 * @returns {Array<Object>} Leads normalizados
 */
function saveLeadsBatch(leads) {
  if (!Array.isArray(leads)) return [];

  const normalizedLeads = leads.map(createLeadModel);
  const mergedBatch = [];

  try {
    ensureDatabaseExists();
    const existingLeads = getAllLeads();
    const leadsById = new Map(existingLeads.map((item) => [item.id, item]));

    for (const lead of normalizedLeads) {
      const previous = leadsById.get(lead.id);
      const merged = {
        ...previous,
        ...lead,
        cnpj: lead.cnpj ?? previous?.cnpj ?? null,
        razaoSocial: lead.razaoSocial ?? previous?.razaoSocial ?? null,
        socios: lead.socios?.length > 0 ? lead.socios : previous?.socios || [],
        instagramUrl: lead.instagramUrl ?? previous?.instagramUrl ?? null,
        ifoodUrl: lead.ifoodUrl ?? previous?.ifoodUrl ?? null,
        menuPlatform: lead.menuPlatform ?? previous?.menuPlatform ?? null,
        email: lead.email ?? previous?.email ?? null,
        allEmails: lead.allEmails?.length > 0 ? lead.allEmails : previous?.allEmails || [],
        allPhones: lead.allPhones?.length > 0 ? lead.allPhones : previous?.allPhones || [],
        status: previous?.status && previous.status !== 'pending' ? previous.status : lead.status || 'pending',
        notes: previous?.notes ? previous.notes : lead.notes || '',
        lastContactedAt: lead.lastContactedAt ?? previous?.lastContactedAt ?? null,
        createdAt: previous?.createdAt || lead.updatedAt
      };
      leadsById.set(lead.id, merged);
      mergedBatch.push(merged);
    }

    const payload = {
      lastUpdated: new Date().toISOString(),
      total: leadsById.size,
      leads: Array.from(leadsById.values())
    };

    fs.writeFileSync(LEADS_DB_PATH, JSON.stringify(payload, null, 2), 'utf8');
    return mergedBatch;
  } catch (error) {
    console.warn(`[LeadRepository] Erro não-fatal ao persistir leads em disco: ${error.message}`);
    return normalizedLeads;
  }
}

/**
 * Atualiza parcialmente um lead específico pelo ID (ex: status CRM, anotações, validação de WhatsApp).
 * @param {string} id
 * @param {Object} patch
 * @returns {Object|null}
 */
function updateLeadById(id, patch = {}) {
  try {
    ensureDatabaseExists();
    const existingLeads = getAllLeads();
    const idx = existingLeads.findIndex((item) => item.id === id);
    if (idx === -1) return null;

    const updated = {
      ...existingLeads[idx],
      ...patch,
      updatedAt: new Date().toISOString()
    };
    existingLeads[idx] = updated;

    fs.writeFileSync(
      LEADS_DB_PATH,
      JSON.stringify({ lastUpdated: new Date().toISOString(), total: existingLeads.length, leads: existingLeads }, null, 2),
      'utf8'
    );
    return updated;
  } catch (error) {
    console.warn(`[LeadRepository] Erro ao atualizar lead ${id}: ${error.message}`);
    return null;
  }
}

/**
 * Marca automaticamente um lead como "contacted" quando um disparo 1 a 1 é enviado para algum de seus números.
 * @param {string} rawPhone
 * @returns {Object|null}
 */
function markLeadContactedByPhone(rawPhone) {
  if (!rawPhone) return null;
  const cleanDigits = String(rawPhone).replace(/\D/g, '').replace(/^55/, '');
  if (!cleanDigits) return null;

  try {
    const existingLeads = getAllLeads();
    let matchedLead = null;

    for (let i = 0; i < existingLeads.length; i++) {
      const lead = existingLeads[i];
      const leadPhoneDigits = String(lead.phone || '').replace(/\D/g, '').replace(/^55/, '');
      const hasInAllPhones =
        Array.isArray(lead.allPhones) &&
        lead.allPhones.some((p) => String(p.digits || p.phone || '').replace(/\D/g, '').replace(/^55/, '') === cleanDigits);

      if (leadPhoneDigits === cleanDigits || hasInAllPhones) {
        existingLeads[i] = {
          ...lead,
          status: lead.status === 'closed' || lead.status === 'replied' ? lead.status : 'contacted',
          lastContactedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        matchedLead = existingLeads[i];
      }
    }

    if (matchedLead) {
      fs.writeFileSync(
        LEADS_DB_PATH,
        JSON.stringify({ lastUpdated: new Date().toISOString(), total: existingLeads.length, leads: existingLeads }, null, 2),
        'utf8'
      );
    }

    return matchedLead;
  } catch {
    return null;
  }
}

module.exports = {
  LEADS_DB_PATH,
  createLeadModel,
  getAllLeads,
  saveLeadsBatch,
  updateLeadById,
  markLeadContactedByPhone
};
