require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { enrichLeadsBatch, enrichLeadWithCnpj } = require('./services/cnpjService');
const { saveLeadsBatch, getAllLeads, updateLeadById } = require('./services/leadRepository');
const whatsappService = require('./services/whatsappService');
const senderService = require('./services/senderService');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  })
);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Clientes SSE para atualizações em tempo real do WhatsApp & Disparo 1 a 1
const sseClients = new Set();

function sendSseEvent(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

whatsappService.on('status_change', (status) => sendSseEvent('whatsapp_status', status));
whatsappService.on('qr', (qr) => sendSseEvent('qr_update', qr));
senderService.on('message_status', (data) => sendSseEvent('dm_message_status', data));
senderService.on('batch_progress', (data) => sendSseEvent('dm_batch_progress', data));
senderService.on('delay_countdown', (data) => sendSseEvent('dm_delay_countdown', data));
senderService.on('batch_end', (data) => sendSseEvent('dm_batch_end', data));
senderService.on('batch_paused', (data) => sendSseEvent('dm_batch_paused', data));
senderService.on('stats_update', (data) => sendSseEvent('dm_stats_update', data));
senderService.on('lead_contacted', (lead) => sendSseEvent('lead_contacted', lead));

// Helpers para tratamento de leads
function formatPhoneForWhatsApp(phone) {
  if (!phone) return '';
  const digitsOnly = phone.replace(/\D/g, '');
  if (!digitsOnly) return '';
  
  // Se já tiver 55 no início e tiver 12 ou 13 dígitos
  if (digitsOnly.startsWith('55') && (digitsOnly.length === 12 || digitsOnly.length === 13)) {
    return digitsOnly;
  }
  
  // Se for DDD + Telefone brasileiro (10 ou 11 dígitos, ex: 11999998888 ou 1133334444)
  if (digitsOnly.length === 10 || digitsOnly.length === 11) {
    return `55${digitsOnly}`;
  }
  
  return digitsOnly;
}

function evaluateOpportunity(rating, reviewCount) {
  const hasRating = rating !== null && rating !== undefined;
  const count = reviewCount || 0;

  // Alta oportunidade para consultoria iFood:
  // 1. Nota < 4.5 (precisa melhorar reputação e qualidade para virar Super Restaurante)
  // 2. Ou baixo volume de avaliações (< 60) indicando pouca tração online
  const isHighOpportunity = (hasRating && rating < 4.5) || count < 60;

  let reason = 'Consolidado: foco em expansão e otimização de margens';
  let badgeColor = 'emerald';

  if (hasRating && rating < 4.0) {
    reason = 'Urgente: Nota baixa (< 4.0). Perda de clientes e baixa conversão no iFood.';
    badgeColor = 'rose';
  } else if (hasRating && rating < 4.5) {
    reason = 'Oportunidade de Ouro: Nota < 4.5. Potencial imediato para conquistar selo Super Restaurante.';
    badgeColor = 'amber';
  } else if (count < 60) {
    reason = 'Baixa tração online: poucas avaliações (< 60). Ideal para escala de pedidos e tráfego.';
    badgeColor = 'sky';
  }

  return { isHighOpportunity, reason, badgeColor };
}

// Rota de status do sistema
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    hasApiKey: Boolean(GOOGLE_PLACES_API_KEY && GOOGLE_PLACES_API_KEY.trim().length > 0),
    port: PORT
  });
});

// Rota GET /api/leads para consultar leads já persistidos localmente
app.get('/api/leads', (req, res) => {
  const leads = getAllLeads();
  res.json({
    total: leads.length,
    withCnpjCount: leads.filter(l => Boolean(l.cnpj)).length,
    leads
  });
});

// Rota PATCH /api/leads/:id para atualizar status CRM e anotações do lead no banco local
app.patch('/api/leads/:id', (req, res) => {
  const { status, notes } = req.body || {};
  const patch = {};
  if (status !== undefined) patch.status = String(status);
  if (notes !== undefined) patch.notes = String(notes);

  const updated = updateLeadById(req.params.id, patch);
  if (!updated) {
    return res.status(404).json({ success: false, error: 'Lead não encontrado.' });
  }
  res.json({ success: true, lead: updated });
});

// Rota POST /api/leads/verify-whatsapp para validar quais números dos leads têm WhatsApp ativo via Baileys
app.post('/api/leads/verify-whatsapp', async (req, res) => {
  try {
    const { leadIds } = req.body || {};
    const allLeads = getAllLeads();
    const targetLeads =
      Array.isArray(leadIds) && leadIds.length > 0
        ? allLeads.filter((l) => leadIds.includes(l.id))
        : allLeads;

    const allPhoneStrings = [];
    for (const l of targetLeads) {
      if (l.phone) allPhoneStrings.push(l.phone);
      if (Array.isArray(l.allPhones)) {
        for (const p of l.allPhones) {
          if (p.phone || p.digits) allPhoneStrings.push(p.digits || p.phone);
        }
      }
    }

    const uniquePhoneStrings = Array.from(new Set(allPhoneStrings));
    const checkResult = await whatsappService.verifyNumbersOnWhatsApp(uniquePhoneStrings);

    if (!checkResult.connected) {
      return res.status(400).json({
        success: false,
        error: 'Conecte o WhatsApp na aba "Sender WhatsApp (Disparo 1 a 1)" para validar números automaticamente.'
      });
    }

    const updatedLeads = [];
    for (const lead of targetLeads) {
      if (Array.isArray(lead.allPhones) && lead.allPhones.length > 0) {
        const updatedPhones = lead.allPhones.map((p) => {
          const digits = String(p.digits || p.phone || '').replace(/\D/g, '').replace(/^55/, '');
          const hasWhatsApp = checkResult.results[digits];
          return {
            ...p,
            hasWhatsApp: typeof hasWhatsApp === 'boolean' ? hasWhatsApp : p.hasWhatsApp ?? null
          };
        });
        const saved = updateLeadById(lead.id, { allPhones: updatedPhones });
        if (saved) updatedLeads.push(saved);
      }
    }

    res.json({
      success: true,
      verifiedCount: Object.keys(checkResult.results).length,
      results: checkResult.results,
      leads: updatedLeads
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cache em memória de municípios do Brasil (IBGE API oficial)
const ibgeMunicipalitiesCache = new Map();

// Rota GET /api/brazil/municipalities para consultar todos os 5.570 municípios do Brasil (ou por UF)
app.get('/api/brazil/municipalities', async (req, res) => {
  try {
    const uf = String(req.query.uf || 'ALL').trim().toUpperCase();
    if (ibgeMunicipalitiesCache.has(uf)) {
      return res.json({ success: true, uf, municipalities: ibgeMunicipalitiesCache.get(uf) });
    }

    const url =
      uf && uf !== 'ALL' && /^[A-Z]{2}$/.test(uf)
        ? `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?orderBy=nome`
        : 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome';

    const response = await axios.get(url, { timeout: 8000 });
    const rawList = Array.isArray(response.data) ? response.data : [];

    const municipalities = rawList.map((m) => {
      const stateUf =
        m?.microrregiao?.mesorregiao?.UF?.sigla ||
        m?.['regiao-imediata']?.['regiao-intermediaria']?.UF?.sigla ||
        (uf !== 'ALL' ? uf : '');
      return {
        name: m.nome,
        uf: stateUf,
        label: stateUf ? `${m.nome} - ${stateUf}` : m.nome
      };
    });

    ibgeMunicipalitiesCache.set(uf, municipalities);
    res.json({ success: true, uf, municipalities });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, municipalities: [] });
  }
});

// Rota POST /api/leads/:id/enrich para re-enriquecer um card individualmente sob demanda
app.post('/api/leads/:id/enrich', async (req, res) => {
  try {
    const allLeads = getAllLeads();
    const target = allLeads.find((l) => l.id === req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, error: 'Lead não encontrado.' });
    }

    const enriched = await enrichLeadWithCnpj(target);
    const [saved] = saveLeadsBatch([enriched]);
    res.json({ success: true, lead: saved || enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rota POST /api/search para busca no Google Places API (New) com Paginação, Cobertura Nacional (Brasil) e Cache Inteligente
app.post('/api/search', async (req, res) => {
  const { query, pageToken } = req.body;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({
      error: 'O parâmetro "query" é obrigatório e deve ser um texto válido.'
    });
  }

  if (!GOOGLE_PLACES_API_KEY) {
    return res.status(500).json({
      error: 'Chave GOOGLE_PLACES_API_KEY não configurada no ficheiro .env do servidor.'
    });
  }

  try {
    const placesApiUrl = 'https://places.googleapis.com/v1/places:searchText';
    
    // FieldMask com campos solicitados pelo usuário + nextPageToken para paginação até 60 leads
    const fieldMask = [
      'places.id',
      'places.displayName',
      'places.formattedAddress',
      'places.nationalPhoneNumber',
      'places.websiteUri',
      'places.rating',
      'places.userRatingCount',
      'places.googleMapsUri',
      'nextPageToken'
    ].join(',');

    const requestBody = {
      textQuery: query.trim(),
      languageCode: 'pt-BR',
      regionCode: 'BR',
      maxResultCount: 20
    };

    if (pageToken && typeof pageToken === 'string' && pageToken.trim()) {
      requestBody.pageToken = pageToken.trim();
    }

    const response = await axios.post(placesApiUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': fieldMask
      },
      timeout: 15000
    });

    const rawPlaces = response.data.places || [];
    const nextPageToken = response.data.nextPageToken || null;

    const existingLeadsById = new Map(getAllLeads().map((item) => [item.id, item]));

    const formattedLeads = rawPlaces.map((place, index) => {
      const id = place.id || `lead_${index}_${Date.now()}`;
      const cached = existingLeadsById.get(id);
      const name = place.displayName?.text || 'Estabelecimento sem nome';
      const phone = place.nationalPhoneNumber || '';
      const address = place.formattedAddress || 'Endereço não informado';
      const rating = typeof place.rating === 'number' ? place.rating : null;
      const userRatingCount = typeof place.userRatingCount === 'number' ? place.userRatingCount : 0;
      const website = place.websiteUri || '';
      const mapsUri = place.googleMapsUri || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${address}`)}`;
      const waNumber = formatPhoneForWhatsApp(phone);
      
      const opportunity = evaluateOpportunity(rating, userRatingCount);

      const pitchMessage = `Olá, equipe do *${name}*! Tudo bem? Me chamo Felipe e sou especialista em crescimento de vendas e otimização operacional para restaurantes no iFood.\n\nNotei seu estabelecimento no Google e percebi oportunidades imediatas para aumentar seu volume de pedidos diários (otimização de cardápio com fotos conversivas, estratégias para conquistar o selo Super Restaurante e redução de cancelamentos).\n\nVocê teria 5 minutinhos para eu te mostrar 3 pontos que podem alavancar o faturamento do delivery de vocês ainda este mês?`;

      return {
        id,
        name,
        cnpj: cached?.cnpj || null,
        razaoSocial: cached?.razaoSocial || null,
        socios: cached?.socios || [],
        instagramUrl: cached?.instagramUrl || null,
        ifoodUrl: cached?.ifoodUrl || null,
        menuPlatform: cached?.menuPlatform || null,
        email: cached?.email || null,
        allEmails: cached?.allEmails || [],
        phone,
        waNumber,
        allPhones: cached?.allPhones || [],
        address,
        rating,
        userRatingCount,
        website,
        mapsUri,
        isHighOpportunity: opportunity.isHighOpportunity,
        opportunityReason: opportunity.reason,
        badgeColor: opportunity.badgeColor,
        pitchMessage,
        status: cached?.status || 'pending',
        notes: cached?.notes || '',
        lastContactedAt: cached?.lastContactedAt || null,
        _isFullyCached: Boolean(cached && cached.cnpj && Array.isArray(cached.allPhones) && cached.allPhones.length > 0 && Array.isArray(cached.socios) && cached.socios.length > 0)
      };
    });

    // Cache Inteligente: só faz scraping/consulta nos leads que ainda não possuem enriquecimento completo no cache
    const leadsNeedingEnrichment = formattedLeads.filter((l) => !l._isFullyCached);
    let enrichedSubset = [];
    if (leadsNeedingEnrichment.length > 0) {
      try {
        enrichedSubset = await enrichLeadsBatch(leadsNeedingEnrichment);
      } catch (enrichErr) {
        console.warn('[CNPJ Enrichment] Falha global controlada no lote de enriquecimento:', enrichErr.message);
        enrichedSubset = leadsNeedingEnrichment;
      }
    }

    const enrichedById = new Map(enrichedSubset.map((item) => [item.id, item]));
    const finalLeadsBatch = formattedLeads.map((l) => {
      const item = enrichedById.get(l.id) || l;
      const { _isFullyCached, ...cleanItem } = item;
      return cleanItem;
    });

    // Persistência local segura (banco JSON) sem interromper o retorno
    const persistedLeads = saveLeadsBatch(finalLeadsBatch);

    return res.json({
      query: query.trim(),
      total: persistedLeads.length,
      nextPageToken,
      highOpportunityCount: persistedLeads.filter(l => l.isHighOpportunity).length,
      withCnpjCount: persistedLeads.filter(l => Boolean(l.cnpj)).length,
      withEmailCount: persistedLeads.filter(l => Boolean(l.email)).length,
      leads: persistedLeads
    });

  } catch (error) {
    console.error('Erro ao consultar a Google Places API:', error.response?.data || error.message);

    const apiError = error.response?.data?.error;
    const statusCode = error.response?.status || 500;
    const errorMessage = apiError?.message || error.message || 'Erro desconhecido ao consultar a Google Places API.';

    return res.status(statusCode).json({
      error: errorMessage,
      details: apiError || null
    });
  }
});

// ========================================================
// SENDER WHATSAPP (QR CODE & DISPARO 1 A 1) API ROUTES
// ========================================================

// Stream SSE para eventos em tempo real (QR Code, Conexão, Progresso 1 a 1)
app.get('/api/sender/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  sseClients.add(res);

  res.write(
    `event: init\ndata: ${JSON.stringify({
      whatsapp: whatsappService.getStatus(),
      qrDataUrl: whatsappService.currentQrDataUrl,
      stats: senderService.getStats()
    })}\n\n`
  );

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.get('/api/sender/status', (req, res) => {
  res.json({
    whatsapp: whatsappService.getStatus(),
    hasQr: Boolean(whatsappService.currentQrDataUrl),
    qrDataUrl: whatsappService.currentQrDataUrl,
    stats: senderService.getStats()
  });
});

app.get('/api/sender/qr', (req, res) => {
  res.json({
    hasQr: Boolean(whatsappService.currentQrDataUrl),
    qrDataUrl: whatsappService.currentQrDataUrl,
    status: whatsappService.status
  });
});

app.post('/api/sender/disconnect', async (req, res) => {
  try {
    await whatsappService.clearAuthAndRestart();
    res.json({ success: true, message: 'WhatsApp desconectado. Novo QR Code será gerado.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/sender/reconnect', async (req, res) => {
  try {
    whatsappService.isInitializing = false;
    whatsappService.init();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/direct-messages', (req, res) => {
  res.json({
    messages: senderService.getMessages(),
    stats: senderService.getStats(),
    settings: senderService.getSettings()
  });
});

app.post('/api/direct-messages', (req, res) => {
  try {
    const { name, phone, message, fileName, fileBase64, mimeType } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Nome e Número são obrigatórios.' });
    }

    let created = senderService.addMessage({ name, phone, message });

    if (fileName && fileBase64) {
      created = senderService.attachFileFromBase64(created.id, { fileName, fileBase64, mimeType });
    }

    res.json({ success: true, message: created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/direct-messages/bulk-import', (req, res) => {
  try {
    const { contacts } = req.body;
    const result = senderService.bulkImportContacts(contacts || []);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/direct-messages/:id', (req, res) => {
  const updated = senderService.updateMessage(req.params.id, req.body);
  if (!updated) {
    return res.status(404).json({ success: false, error: 'Contato não encontrado.' });
  }
  res.json({ success: true, message: updated });
});

app.delete('/api/direct-messages/:id', (req, res) => {
  const deleted = senderService.deleteMessage(req.params.id);
  res.json({ success: deleted });
});

app.delete('/api/direct-messages', (req, res) => {
  const result = senderService.clearAll();
  res.json(result);
});

// Upload de Arquivo (PDF, PNG, JPG, JPEG, WEBP, GIF) para um disparo 1 a 1
app.post('/api/direct-messages/:id/attachment', (req, res) => {
  try {
    const { id } = req.params;
    const { fileName, fileBase64, mimeType } = req.body;

    if (!fileName || !fileBase64) {
      return res.status(400).json({ success: false, error: 'Arquivo não fornecido.' });
    }

    const updated = senderService.attachFileFromBase64(id, { fileName, fileBase64, mimeType });
    res.json({ success: true, message: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/direct-messages/:id/attachment', (req, res) => {
  try {
    const updated = senderService.removeFile(req.params.id);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Contato não encontrado.' });
    }
    res.json({ success: true, message: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/direct-messages/send-single/:id', async (req, res) => {
  try {
    const result = await senderService.sendSingle(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/direct-messages/start-batch', async (req, res) => {
  try {
    const result = await senderService.startBatchSend();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/direct-messages/pause-batch', (req, res) => {
  const result = senderService.pauseBatchSend();
  res.json(result);
});

app.post('/api/direct-messages/reset-status', (req, res) => {
  const result = senderService.resetStatus();
  res.json(result);
});

// Fallback para SPA / index.html
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Servidor de Prospecção iFood rodando na porta ${PORT}`);
  console.log(`🌐 Acesse: http://localhost:${PORT}`);
  console.log(`🔑 Google Places API Key: ${GOOGLE_PLACES_API_KEY ? 'Configurada (OK)' : 'NÃO CONFIGURADA'}`);
  console.log(`=======================================================`);
  whatsappService.init();
});
