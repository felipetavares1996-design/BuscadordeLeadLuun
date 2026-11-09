/**
 * Cloudflare Worker Entrypoint - Buscador de Leads Brasil Todo + Bridge WhatsApp Sender (Baileys)
 */

const CNPJ_REGEX = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
const MAILTO_REGEX = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
const WA_LINK_REGEX = /(?:wa\.me\/|api\.whatsapp\.com\/send\?[^"'\s>]*phone=)(\d{10,13})/gi;
const TEL_LINK_REGEX = /href=["']tel:([^"']+)["']/gi;
const BR_PHONE_TEXT_REGEX =
  /(?:\+?55\s?)?\((?:1[1-9]|2[12478]|3[1-578]|4[1-9]|5[1345]|6[1-9]|7[134579]|8[1-9]|9[1-9])\)\s?(?:9\s?\d{4}|\d{4})[\s.-]?\d{4}\b/g;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PLATFORM_CNPJ_BLOCKLIST = new Set([
  '14380200000121',
  '13347016000117',
  '06990590000123'
]);

const IGNORED_EMAIL_DOMAINS = new Set([
  'sentry.io', 'sentry-next.wixpress.com', 'wixpress.com', 'wix.com',
  'example.com', 'exemplo.com', 'exemplo.com.br', 'seudominio.com',
  'seudominio.com.br', 'dominio.com', 'dominio.com.br', 'email.com',
  'wordpress.org', 'w3.org', 'schema.org', 'googleapis.com', 'cloudflare.com',
  'ifood.com.br', 'facebook.com', 'instagram.com', 'linktr.ee', 'google.com'
]);

const IGNORED_EMAIL_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.css', '.js', '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.ico', '.map', '.json', '.xml'
];

const ibgeMemCache = new Map();

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders()
    }
  });
}

function stripNonDigits(val) {
  if (!val || typeof val !== 'string') return '';
  return val.replace(/\D/g, '');
}

function formatCnpj(cnpj) {
  const digits = stripNonDigits(cnpj);
  if (digits.length !== 14) return null;
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function isValidCnpj(rawCnpj) {
  const digits = stripNonDigits(rawCnpj);
  if (digits.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;
  if (PLATFORM_CNPJ_BLOCKLIST.has(digits)) return false;

  const calc = (base, weights) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) sum += Number(base[i]) * weights[i];
    const rem = sum % 11;
    return rem < 2 ? 0 : 11 - rem;
  };

  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  if (calc(digits.slice(0, 12), w1) !== Number(digits[12])) return false;
  if (calc(digits.slice(0, 13), w2) !== Number(digits[13])) return false;
  return true;
}

function normalizeBrazilianPhone(rawPhone, source = 'Google') {
  if (!rawPhone || typeof rawPhone !== 'string') return null;
  let digits = stripNonDigits(rawPhone);
  if (!digits) return null;
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  if (digits.startsWith('0') && (digits.length === 11 || digits.length === 12)) {
    digits = digits.slice(1);
  }
  if (digits.length !== 10 && digits.length !== 11) return null;
  const ddd = Number(digits.slice(0, 2));
  if (ddd < 11 || ddd > 99 || ddd % 10 === 0) return null;
  const numberPart = digits.slice(2);
  if (/^(\d)\1+$/.test(numberPart)) return null;

  const isMobile = digits.length === 11 && numberPart.startsWith('9');
  const isValidLandline = digits.length === 10 && /^[2-5]/.test(numberPart);
  if (!isMobile && !isValidLandline) return null;

  const formatted = isMobile
    ? `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
    : `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;

  return {
    digits,
    formatted,
    waNumber: `55${digits}`,
    isMobile,
    source
  };
}

function mergeAndDeduplicatePhones(candidates = []) {
  const mapByDigits = new Map();
  for (const item of candidates) {
    if (!item || !item.raw) continue;
    const norm = normalizeBrazilianPhone(item.raw, item.source);
    if (!norm) continue;
    const existing = mapByDigits.get(norm.digits);
    if (existing) {
      if (!existing.sources.includes(norm.source)) {
        existing.sources.push(norm.source);
        existing.source = existing.sources.join(' + ');
      }
    } else {
      mapByDigits.set(norm.digits, {
        digits: norm.digits,
        phone: norm.formatted,
        waNumber: norm.waNumber,
        isMobile: norm.isMobile,
        source: norm.source,
        sources: [norm.source]
      });
    }
  }
  const list = Array.from(mapByDigits.values()).map(({ sources, ...rest }) => rest);
  list.sort((a, b) => Number(b.isMobile) - Number(a.isMobile));
  return list;
}

function sanitizeEmail(rawEmail) {
  if (!rawEmail || typeof rawEmail !== 'string') return null;
  const cleaned = rawEmail
    .trim()
    .toLowerCase()
    .replace(/^mailto:/i, '')
    .split('?')[0]
    .replace(/^[.,;:!?"'()[\]{}<>]+|[.,;:!?"'()[\]{}<>]+$/g, '');

  if (!cleaned || cleaned.length > 90 || !cleaned.includes('@')) return null;
  const [localPart, domain] = cleaned.split('@');
  if (!localPart || !domain || localPart.length < 2) return null;
  if (IGNORED_EMAIL_DOMAINS.has(domain)) return null;
  for (const ext of IGNORED_EMAIL_EXTENSIONS) {
    if (cleaned.endsWith(ext)) return null;
  }
  if (/^\d+x\d+$/.test(localPart) || /^[0-9a-f]{24,}$/.test(localPart)) return null;
  return cleaned;
}

function formatPartnerName(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  const cleaned = rawName
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '')
    .replace(/\b\*{2,}\d+\*{2,}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 3) return null;
  return cleaned
    .toLowerCase()
    .split(' ')
    .map((w) => (['de', 'da', 'do', 'dos', 'das', 'e'].includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function extractDigitalPresenceFromHtml(htmlContent = '', websiteUri = '') {
  let instagramUrl = null;
  let ifoodUrl = null;
  let menuPlatform = null;
  const combinedText = `${websiteUri || ''} ${htmlContent || ''}`;

  const igRegex = /https?:\/\/(?:www\.)?instagram\.com\/([a-zA-Z0-9._]{2,30})\/?/gi;
  const igIgnored = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'share', 'about', 'legal']);
  let igMatch;
  while ((igMatch = igRegex.exec(combinedText)) !== null) {
    const handle = igMatch[1].replace(/\/$/, '');
    if (handle && !igIgnored.has(handle.toLowerCase())) {
      instagramUrl = `https://www.instagram.com/${handle}`;
      break;
    }
  }

  const ifoodRegex = /https?:\/\/(?:www\.)?ifood\.com\.br\/delivery\/[^\s"'<>)]+/i;
  const ifoodMatch = combinedText.match(ifoodRegex);
  if (ifoodMatch) ifoodUrl = ifoodMatch[0];

  const platforms = [
    { name: 'iFood Cardápio', pattern: /cardapiodigital\.ifood\.com\.br|ifood\.com\.br\/delivery/i },
    { name: 'Goomer', pattern: /goomer\.app/i },
    { name: 'Anota AI', pattern: /anota\.ai|pedido\.anota\.ai/i },
    { name: 'Cardápio Web', pattern: /cardapioweb\.com/i },
    { name: 'Menudino', pattern: /menudino\.com/i },
    { name: 'Neemo', pattern: /neemo\.com\.br|deliveryapp\.neemo/i },
    { name: 'Saipos', pattern: /saipos\.com/i },
    { name: 'Yooga', pattern: /yooga\.app|delivery\.yooga/i },
    { name: 'OlaClick', pattern: /olaclick\.com|ola\.click/i },
    { name: 'JotaJá', pattern: /jotaja\.com/i },
    { name: 'InstaDelivery', pattern: /instadelivery\.com\.br/i },
    { name: 'Consumer / MenuDino', pattern: /programaconsumer\.com\.br/i },
    { name: 'Linktree', pattern: /linktr\.ee/i }
  ];
  for (const p of platforms) {
    if (p.pattern.test(combinedText)) {
      menuPlatform = p.name;
      break;
    }
  }
  return { instagramUrl, ifoodUrl, menuPlatform };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4200) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function fetchPublicCnpjDetails(cnpj) {
  const digits = stripNonDigits(cnpj);
  if (digits.length !== 14) return { razaoSocial: null, socios: [], emails: [], phones: [] };

  let razaoSocial = null;
  const sociosSet = new Set();
  const emails = new Set();
  const phones = [];

  try {
    const res = await fetchWithTimeout(`https://brasilapi.com.br/api/cnpj/v1/${digits}`, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT }
    }, 3800);
    if (res.ok) {
      const data = await res.json();
      if (data.razao_social) razaoSocial = String(data.razao_social).trim();
      const em = sanitizeEmail(data.email);
      if (em) emails.add(em);
      if (data.ddd_telefone_1) phones.push({ raw: String(data.ddd_telefone_1), source: 'CNPJ' });
      if (data.ddd_telefone_2) phones.push({ raw: String(data.ddd_telefone_2), source: 'CNPJ' });
      if (Array.isArray(data.qsa)) {
        for (const s of data.qsa) {
          const pName = formatPartnerName(s?.nome_socio || s?.nome);
          if (pName) sociosSet.add(pName);
        }
      }
    }
  } catch {}

  if (phones.length === 0 || emails.size === 0 || sociosSet.size === 0) {
    try {
      const res = await fetchWithTimeout(`https://receitaws.com.br/v1/cnpj/${digits}`, {
        headers: { 'User-Agent': DEFAULT_USER_AGENT }
      }, 3800);
      if (res.ok) {
        const data = await res.json();
        if (data && data.status !== 'ERROR') {
          if (!razaoSocial && data.nome) razaoSocial = String(data.nome).trim();
          const em = sanitizeEmail(data.email);
          if (em) emails.add(em);
          if (data.telefone) {
            for (const part of String(data.telefone).split('/')) {
              phones.push({ raw: part.trim(), source: 'CNPJ' });
            }
          }
          if (Array.isArray(data.qsa)) {
            for (const s of data.qsa) {
              const pName = formatPartnerName(s?.nome);
              if (pName) sociosSet.add(pName);
            }
          }
        }
      }
    } catch {}
  }

  return {
    razaoSocial,
    socios: Array.from(sociosSet),
    emails: Array.from(emails),
    phones
  };
}

async function enrichSingleLeadEdge(lead) {
  try {
    let foundCnpj = lead.cnpj && isValidCnpj(lead.cnpj) ? formatCnpj(lead.cnpj) : null;
    let razaoSocial = lead.razaoSocial || null;
    let socios = Array.isArray(lead.socios) ? [...lead.socios] : [];
    let instagramUrl = lead.instagramUrl || null;
    let ifoodUrl = lead.ifoodUrl || null;
    let menuPlatform = lead.menuPlatform || null;
    const emailSet = new Set();
    const phoneCandidates = [];

    if (lead.phone) {
      phoneCandidates.push({ raw: lead.phone, source: 'Google' });
    }

    if (lead.website && typeof lead.website === 'string' && lead.website.trim()) {
      const initialPres = extractDigitalPresenceFromHtml('', lead.website);
      if (initialPres.instagramUrl) instagramUrl = initialPres.instagramUrl;
      if (initialPres.ifoodUrl) ifoodUrl = initialPres.ifoodUrl;
      if (initialPres.menuPlatform) menuPlatform = initialPres.menuPlatform;

      let urls = [];
      try {
        const u = new URL(lead.website.startsWith('http') ? lead.website : `https://${lead.website}`);
        urls = [u.href, `${u.origin}/contato`];
      } catch {}

      for (const url of urls) {
        try {
          const res = await fetchWithTimeout(url, { headers: { 'User-Agent': DEFAULT_USER_AGENT } }, 3500);
          if (!res.ok) continue;
          const html = await res.text();
          if (!html) continue;

          if (!foundCnpj) {
            const matches = html.match(CNPJ_REGEX) || [];
            for (const m of matches) {
              if (isValidCnpj(m)) {
                foundCnpj = formatCnpj(m);
                break;
              }
            }
          }

          let mMatch;
          MAILTO_REGEX.lastIndex = 0;
          while ((mMatch = MAILTO_REGEX.exec(html)) !== null) {
            const em = sanitizeEmail(mMatch[1]);
            if (em) emailSet.add(em);
          }
          const eMatches = html.match(EMAIL_REGEX) || [];
          for (const rawEm of eMatches) {
            const em = sanitizeEmail(rawEm);
            if (em) emailSet.add(em);
          }

          let waMatch;
          WA_LINK_REGEX.lastIndex = 0;
          while ((waMatch = WA_LINK_REGEX.exec(html)) !== null) {
            phoneCandidates.push({ raw: waMatch[1], source: 'Site' });
          }
          let telMatch;
          TEL_LINK_REGEX.lastIndex = 0;
          while ((telMatch = TEL_LINK_REGEX.exec(html)) !== null) {
            phoneCandidates.push({ raw: telMatch[1], source: 'Site' });
          }
          const brMatches = html.match(BR_PHONE_TEXT_REGEX) || [];
          for (const rawP of brMatches) {
            phoneCandidates.push({ raw: rawP, source: 'Site' });
          }

          const pres = extractDigitalPresenceFromHtml(html, url);
          if (!instagramUrl && pres.instagramUrl) instagramUrl = pres.instagramUrl;
          if (!ifoodUrl && pres.ifoodUrl) ifoodUrl = pres.ifoodUrl;
          if (!menuPlatform && pres.menuPlatform) menuPlatform = pres.menuPlatform;

          if (foundCnpj && emailSet.size > 0 && phoneCandidates.length > 1) break;
        } catch {}
      }
    }

    if (foundCnpj) {
      const cnpjDetails = await fetchPublicCnpjDetails(foundCnpj);
      if (cnpjDetails.razaoSocial) razaoSocial = cnpjDetails.razaoSocial;
      if (cnpjDetails.socios?.length) {
        socios = Array.from(new Set([...socios, ...cnpjDetails.socios]));
      }
      if (cnpjDetails.emails?.length) {
        for (const em of cnpjDetails.emails) emailSet.add(em);
      }
      if (cnpjDetails.phones?.length) {
        phoneCandidates.push(...cnpjDetails.phones);
      }
    }

    const allEmails = Array.from(emailSet);
    const allPhones = mergeAndDeduplicatePhones(phoneCandidates);
    const primaryPhoneObj = allPhones[0] || null;

    return {
      ...lead,
      cnpj: foundCnpj,
      razaoSocial,
      socios,
      instagramUrl,
      ifoodUrl,
      menuPlatform,
      email: allEmails[0] || lead.email || null,
      allEmails,
      phone: lead.phone || (primaryPhoneObj ? primaryPhoneObj.phone : ''),
      waNumber: lead.waNumber || (primaryPhoneObj ? primaryPhoneObj.waNumber : ''),
      allPhones
    };
  } catch {
    return lead;
  }
}

function evaluateOpportunity(rating, userRatingCount) {
  const hasRating = typeof rating === 'number';
  const reviews = typeof userRatingCount === 'number' ? userRatingCount : 0;
  if (!hasRating || reviews === 0) {
    return { isHighOpportunity: true, reason: 'Sem avaliações ou recém-cadastrado (Forte potencial para estruturação inicial)', badgeColor: 'amber' };
  }
  if (rating < 4.4 && reviews < 100) {
    return { isHighOpportunity: true, reason: 'Nota crítica (< 4.4) e baixo volume de avaliações (< 100)', badgeColor: 'red' };
  }
  if (rating < 4.4) {
    return { isHighOpportunity: true, reason: `Nota abaixo do ideal (${rating.toFixed(1)}) — precisa de gestão de reputação e operação`, badgeColor: 'red' };
  }
  if (reviews < 50) {
    return { isHighOpportunity: true, reason: `Poucas avaliações (${reviews}) — precisa de aceleração de vendas e visibilidade`, badgeColor: 'orange' };
  }
  return { isHighOpportunity: false, reason: 'Consolidado: foco em expansão e otimização de margens', badgeColor: 'emerald' };
}

async function getStoredLeads(env) {
  if (!env.LEADS_KV) return [];
  try {
    const raw = await env.LEADS_KV.get('leads_list', 'json');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function saveStoredLeads(env, leadsBatch) {
  if (!env.LEADS_KV) return leadsBatch;
  try {
    const existing = await getStoredLeads(env);
    const map = new Map(existing.map((item) => [item.id, item]));
    const now = new Date().toISOString();

    const updatedBatch = leadsBatch.map((lead) => {
      const prev = map.get(lead.id);
      const merged = {
        ...prev,
        ...lead,
        cnpj: lead.cnpj || prev?.cnpj || null,
        razaoSocial: lead.razaoSocial || prev?.razaoSocial || null,
        socios: lead.socios?.length ? lead.socios : (prev?.socios || []),
        instagramUrl: lead.instagramUrl || prev?.instagramUrl || null,
        ifoodUrl: lead.ifoodUrl || prev?.ifoodUrl || null,
        menuPlatform: lead.menuPlatform || prev?.menuPlatform || null,
        email: lead.email || prev?.email || null,
        allEmails: lead.allEmails?.length ? lead.allEmails : (prev?.allEmails || []),
        allPhones: lead.allPhones?.length ? lead.allPhones : (prev?.allPhones || []),
        status: lead.status || prev?.status || 'pending',
        notes: lead.notes !== undefined ? lead.notes : (prev?.notes || ''),
        updatedAt: now
      };
      map.set(merged.id, merged);
      return merged;
    });

    const all = Array.from(map.values()).slice(-500);
    await env.LEADS_KV.put('leads_list', JSON.stringify(all));
    return updatedBatch;
  } catch {
    return leadsBatch;
  }
}

let memWaState = null;
let lastKvStateSig = '';
let memPendingActions = [];

function sanitizeExpiredQr(stateObj) {
  if (!stateObj) return stateObj;
  const ageMs = Date.now() - (stateObj.updatedAtMs || 0);
  // Se o servidor local não sincronizou nos últimos 55s, o QR Code expirou no WhatsApp
  if (ageMs > 55000 && stateObj.qrDataUrl) {
    return {
      ...stateObj,
      qrDataUrl: null,
      whatsapp: { ...(stateObj.whatsapp || {}), status: 'connecting', hasQr: false }
    };
  }
  return stateObj;
}

async function getWaLiveState(env) {
  if (memWaState && Date.now() - (memWaState.updatedAtMs || 0) < 25000) {
    return sanitizeExpiredQr(memWaState);
  }
  if (env.LEADS_KV) {
    try {
      const kvState = await env.LEADS_KV.get('wa_live_state', 'json');
      if (kvState) {
        if (!memWaState || (kvState.updatedAtMs || 0) > (memWaState.updatedAtMs || 0)) {
          memWaState = kvState;
        }
        return sanitizeExpiredQr(memWaState);
      }
    } catch {}
  }
  return sanitizeExpiredQr(
    memWaState || {
      whatsapp: { status: 'connecting', user: null, hasQr: false },
      qrDataUrl: null,
      pairingCode: null,
      stats: { total: 0, sent: 0, pending: 0, failed: 0, isBatchRunning: false },
      messages: [],
      updatedAtMs: 0
    }
  );
}

async function saveWaLiveState(env, stateObj, forceKv = false) {
  stateObj.updatedAtMs = Date.now();
  memWaState = stateObj;

  // Só grava no Cloudflare KV quando o QR Code, código de pareamento, status ou contadores mudarem (evita estourar limite diário do KV!)
  const sig = `${stateObj.whatsapp?.status || ''}|${(stateObj.qrDataUrl || '').slice(-32)}|${stateObj.pairingCode || ''}|${stateObj.stats?.total || 0}|${stateObj.stats?.sent || 0}|${stateObj.stats?.pending || 0}`;
  if ((forceKv || sig !== lastKvStateSig) && env.LEADS_KV) {
    lastKvStateSig = sig;
    try {
      await env.LEADS_KV.put('wa_live_state', JSON.stringify(stateObj));
    } catch {}
  }
}

async function enqueueWaAction(env, action) {
  memPendingActions.push(action);
  if (env.LEADS_KV) {
    try {
      const existing = (await env.LEADS_KV.get('wa_pending_actions', 'json')) || [];
      existing.push(action);
      await env.LEADS_KV.put('wa_pending_actions', JSON.stringify(existing));
    } catch {}
  }
}

async function drainWaActions(env) {
  const fromMem = [...memPendingActions];
  memPendingActions = [];
  let fromKv = [];
  if (env.LEADS_KV) {
    try {
      fromKv = (await env.LEADS_KV.get('wa_pending_actions', 'json')) || [];
      if (fromKv.length > 0) {
        await env.LEADS_KV.put('wa_pending_actions', JSON.stringify([]));
      }
    } catch {}
  }
  const seenIds = new Set();
  const merged = [];
  for (const act of [...fromMem, ...fromKv]) {
    if (!act) continue;
    const aid = act.actionId || JSON.stringify(act);
    if (!seenIds.has(aid)) {
      seenIds.add(aid);
      merged.push(act);
    }
  }
  return merged;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 1. Sincronização em tempo real do QR Code, Status do WhatsApp e Fila 1 a 1 (server.js <-> Cloudflare Worker)
    if (url.pathname === '/api/bridge/sync' && request.method === 'POST') {
      try {
        const body = await request.json();
        const pendingActions = await drainWaActions(env);
        await saveWaLiveState(env, {
          whatsapp: body.whatsapp || { status: 'disconnected', user: null, hasQr: false },
          qrDataUrl: body.qrDataUrl || null,
          pairingCode: body.pairingCode || null,
          stats: body.stats || { total: 0, sent: 0, pending: 0, failed: 0, isBatchRunning: false },
          messages: Array.isArray(body.messages) ? body.messages : [],
          updatedAt: new Date().toISOString()
        });
        return jsonResponse({ success: true, pendingActions });
      } catch (err) {
        return jsonResponse({ success: false, error: err.message }, 400);
      }
    }

    if (url.pathname === '/api/bridge/status' && request.method === 'GET') {
      const state = await getWaLiveState(env);
      return jsonResponse({
        success: true,
        bridgeUrl: null,
        hasQr: Boolean(state.qrDataUrl),
        waStatus: state.whatsapp?.status || 'disconnected'
      });
    }

    // 2. Status da API
    if (url.pathname === '/api/status' && request.method === 'GET') {
      const hasKey = Boolean(env.GOOGLE_PLACES_API_KEY && env.GOOGLE_PLACES_API_KEY.length > 10);
      return jsonResponse({ status: 'online', hasApiKey: hasKey });
    }

    // 3. Municípios do Brasil (5.570 cidades via IBGE)
    if (url.pathname === '/api/brazil/municipalities' && request.method === 'GET') {
      try {
        const uf = String(url.searchParams.get('uf') || 'ALL').trim().toUpperCase();
        if (ibgeMemCache.has(uf)) {
          return jsonResponse({ success: true, uf, municipalities: ibgeMemCache.get(uf) });
        }
        const ibgeUrl =
          uf && uf !== 'ALL' && /^[A-Z]{2}$/.test(uf)
            ? `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?orderBy=nome`
            : 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios?orderBy=nome';

        const res = await fetchWithTimeout(ibgeUrl, {}, 8000);
        const rawList = res.ok ? await res.json() : [];
        const municipalities = (Array.isArray(rawList) ? rawList : []).map((m) => {
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
        ibgeMemCache.set(uf, municipalities);
        return jsonResponse({ success: true, uf, municipalities });
      } catch (err) {
        return jsonResponse({ success: false, error: err.message, municipalities: [] }, 500);
      }
    }

    // 4. Leads persistidos (GET /api/leads, PATCH /api/leads/:id, POST /api/leads/:id/enrich)
    if (url.pathname === '/api/leads' && request.method === 'GET') {
      const leads = await getStoredLeads(env);
      return jsonResponse({ total: leads.length, leads });
    }

    const leadPatchMatch = url.pathname.match(/^\/api\/leads\/([^/]+)$/);
    if (leadPatchMatch && request.method === 'PATCH') {
      const id = decodeURIComponent(leadPatchMatch[1]);
      const body = await request.json();
      const leads = await getStoredLeads(env);
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return jsonResponse({ success: false, error: 'Lead não encontrado.' }, 404);
      if (typeof body.status === 'string') leads[idx].status = body.status;
      if (typeof body.notes === 'string') leads[idx].notes = body.notes;
      leads[idx].updatedAt = new Date().toISOString();
      if (env.LEADS_KV) await env.LEADS_KV.put('leads_list', JSON.stringify(leads));
      return jsonResponse({ success: true, lead: leads[idx] });
    }

    const leadEnrichMatch = url.pathname.match(/^\/api\/leads\/([^/]+)\/enrich$/);
    if (leadEnrichMatch && request.method === 'POST') {
      const id = decodeURIComponent(leadEnrichMatch[1]);
      const leads = await getStoredLeads(env);
      const target = leads.find((l) => l.id === id);
      if (!target) return jsonResponse({ success: false, error: 'Lead não encontrado.' }, 404);
      const enriched = await enrichSingleLeadEdge(target);
      const [saved] = await saveStoredLeads(env, [enriched]);
      return jsonResponse({ success: true, lead: saved || enriched });
    }

    // 5. Busca no Google Places API + Enriquecimento de CNPJ/QSA/Emails/Telefones (POST /api/search)
    if (url.pathname === '/api/search' && request.method === 'POST') {
      try {
        const body = await request.json();
        const query = String(body.query || '').trim();
        const pageToken = body.pageToken ? String(body.pageToken).trim() : null;

        if (!query) {
          return jsonResponse({ error: 'O parâmetro "query" é obrigatório.' }, 400);
        }
        if (!env.GOOGLE_PLACES_API_KEY) {
          return jsonResponse({ error: 'GOOGLE_PLACES_API_KEY não configurada no Cloudflare Worker.' }, 500);
        }

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

        const reqBody = {
          textQuery: query,
          languageCode: 'pt-BR',
          regionCode: 'BR',
          maxResultCount: 20
        };
        if (pageToken) reqBody.pageToken = pageToken;

        const placesRes = await fetchWithTimeout('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
            'X-Goog-FieldMask': fieldMask
          },
          body: JSON.stringify(reqBody)
        }, 12000);

        const placesData = await placesRes.json();
        if (!placesRes.ok) {
          return jsonResponse({ error: placesData?.error?.message || 'Erro na Google Places API' }, placesRes.status);
        }

        const rawPlaces = placesData.places || [];
        const nextPageToken = placesData.nextPageToken || null;
        const existingLeads = await getStoredLeads(env);
        const existingById = new Map(existingLeads.map((l) => [l.id, l]));

        const formattedLeads = rawPlaces.map((place, index) => {
          const id = place.id || `lead_${index}_${Date.now()}`;
          const cached = existingById.get(id);
          const name = place.displayName?.text || 'Estabelecimento sem nome';
          const phone = place.nationalPhoneNumber || '';
          const address = place.formattedAddress || 'Endereço não informado';
          const rating = typeof place.rating === 'number' ? place.rating : null;
          const userRatingCount = typeof place.userRatingCount === 'number' ? place.userRatingCount : 0;
          const website = place.websiteUri || '';
          const mapsUri = place.googleMapsUri || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${address}`)}`;
          const normPhone = normalizeBrazilianPhone(phone, 'Google');
          const waNumber = normPhone ? normPhone.waNumber : '';
          const opportunity = evaluateOpportunity(rating, userRatingCount);

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
            status: cached?.status || 'pending',
            notes: cached?.notes || ''
          };
        });

        // Enriquecimento rápido em lotes paralelos
        const enrichedLeads = await Promise.all(
          formattedLeads.map((lead) => enrichSingleLeadEdge(lead))
        );

        const persistedLeads = await saveStoredLeads(env, enrichedLeads);

        return jsonResponse({
          query,
          total: persistedLeads.length,
          nextPageToken,
          highOpportunityCount: persistedLeads.filter((l) => l.isHighOpportunity).length,
          withCnpjCount: persistedLeads.filter((l) => Boolean(l.cnpj)).length,
          withEmailCount: persistedLeads.filter((l) => Boolean(l.email)).length,
          leads: persistedLeads
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // 6. Rotas do WhatsApp Sender (QR Code & Disparo 1 a 1) via Cloud-Sync Bridge (server.js <-> Cloudflare KV)
    if (url.pathname === '/api/sender/status' && request.method === 'GET') {
      const state = await getWaLiveState(env);
      return jsonResponse({
        whatsapp: state.whatsapp || { status: 'connecting', user: null, hasQr: false },
        hasQr: Boolean(state.qrDataUrl),
        qrDataUrl: state.qrDataUrl || null,
        pairingCode: state.pairingCode || null,
        stats: state.stats || { total: 0, sent: 0, pending: 0, failed: 0, isBatchRunning: false }
      });
    }

    if (url.pathname === '/api/sender/pairing-code' && request.method === 'POST') {
      const body = await request.json();
      const phone = String(body.phone || '').trim();
      await enqueueWaAction(env, {
        actionId: `act_${Date.now()}_pair_${phone}`,
        type: 'request_pairing_code',
        payload: { phone }
      });
      return jsonResponse({
        success: true,
        queued: true,
        message: 'Solicitando código de 8 dígitos ao WhatsApp (aguarde ~3 segundos)...'
      });
    }

    if (url.pathname === '/api/sender/qr' && request.method === 'GET') {
      const state = await getWaLiveState(env);
      return jsonResponse({
        hasQr: Boolean(state.qrDataUrl),
        qrDataUrl: state.qrDataUrl || null,
        status: state.whatsapp?.status || 'connecting'
      });
    }

    if (url.pathname === '/api/sender/stream' && request.method === 'GET') {
      const state = await getWaLiveState(env);
      const ssePayload = `event: init\ndata: ${JSON.stringify({
        whatsapp: state.whatsapp || { status: 'connecting', user: null, hasQr: false },
        qrDataUrl: state.qrDataUrl || null,
        stats: state.stats || { total: 0, sent: 0, pending: 0, failed: 0, isBatchRunning: false }
      })}\n\n`;
      return new Response(ssePayload, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...corsHeaders()
        }
      });
    }

    if (url.pathname === '/api/sender/disconnect' && request.method === 'POST') {
      await enqueueWaAction(env, {
        actionId: `act_${Date.now()}_disc`,
        type: 'disconnect_wa'
      });
      return jsonResponse({ success: true, message: 'Comando enviado. Gerando novo QR Code...' });
    }

    if (url.pathname === '/api/sender/reconnect' && request.method === 'POST') {
      await enqueueWaAction(env, {
        actionId: `act_${Date.now()}_reconn`,
        type: 'reconnect_wa'
      });
      return jsonResponse({ success: true });
    }

    if (url.pathname === '/api/direct-messages' && request.method === 'GET') {
      const state = await getWaLiveState(env);
      return jsonResponse({
        messages: state.messages || [],
        stats: state.stats || { total: 0, sent: 0, pending: 0, failed: 0, isBatchRunning: false }
      });
    }

    if (url.pathname === '/api/direct-messages' && request.method === 'POST') {
      const body = await request.json();
      await enqueueWaAction(env, {
        actionId: `act_${Date.now()}_add_${Math.random().toString(36).slice(2, 6)}`,
        type: 'add_message',
        payload: body
      });
      // Atualização otimista para resposta imediata na UI
      const state = await getWaLiveState(env);
      const norm = normalizeBrazilianPhone(body.phone || '', 'Manual');
      const newMsg = {
        id: `dm_${Date.now()}`,
        name: body.name || 'Cliente',
        phone: norm ? norm.digits : stripNonDigits(body.phone || ''),
        message: body.message || '',
        status: 'pending',
        fileName: body.fileName || null,
        createdAt: new Date().toISOString()
      };
      state.messages = [...(state.messages || []), newMsg];
      state.stats = {
        ...(state.stats || {}),
        total: state.messages.length,
        pending: state.messages.filter((m) => m.status === 'pending').length
      };
      await saveWaLiveState(env, state);
      return jsonResponse({ success: true, message: newMsg });
    }

    if (url.pathname === '/api/direct-messages/bulk-import' && request.method === 'POST') {
      const body = await request.json();
      const contacts = Array.isArray(body.contacts) ? body.contacts : [];
      await enqueueWaAction(env, {
        actionId: `act_${Date.now()}_bulk_${Math.random().toString(36).slice(2, 6)}`,
        type: 'bulk_import',
        payload: { contacts }
      });
      return jsonResponse({ success: true, addedCount: contacts.length });
    }

    if (url.pathname === '/api/direct-messages' && request.method === 'DELETE') {
      await enqueueWaAction(env, {
        actionId: `act_${Date.now()}_clear`,
        type: 'clear_all'
      });
      const state = await getWaLiveState(env);
      state.messages = [];
      state.stats = { total: 0, sent: 0, pending: 0, failed: 0, isBatchRunning: false };
      await saveWaLiveState(env, state);
      return jsonResponse({ success: true, cleared: true });
    }

    if (url.pathname === '/api/direct-messages/start-batch' && request.method === 'POST') {
      const state = await getWaLiveState(env);
      const pendingCount = (state.messages || []).filter((m) => m.status === 'pending' || m.status === 'failed').length;
      if (pendingCount === 0) {
        return jsonResponse({ success: true, noPending: true, total: 0 });
      }
      await enqueueWaAction(env, {
        actionId: `act_${Date.now()}_start_batch`,
        type: 'start_batch'
      });
      return jsonResponse({ success: true, total: pendingCount });
    }

    if (url.pathname === '/api/direct-messages/pause-batch' && request.method === 'POST') {
      await enqueueWaAction(env, {
        actionId: `act_${Date.now()}_pause_batch`,
        type: 'pause_batch'
      });
      return jsonResponse({ success: true, paused: true });
    }

    if (url.pathname === '/api/direct-messages/reset-status' && request.method === 'POST') {
      await enqueueWaAction(env, {
        actionId: `act_${Date.now()}_reset`,
        type: 'reset_status'
      });
      return jsonResponse({ success: true });
    }

    const sendSingleMatch = url.pathname.match(/^\/api\/direct-messages\/send-single\/([^/]+)$/);
    if (sendSingleMatch && request.method === 'POST') {
      const id = decodeURIComponent(sendSingleMatch[1]);
      await enqueueWaAction(env, {
        actionId: `act_${Date.now()}_send_${id}`,
        type: 'send_single',
        payload: { id }
      });
      return jsonResponse({ success: true, queued: true });
    }

    const dmAttachmentMatch = url.pathname.match(/^\/api\/direct-messages\/([^/]+)\/attachment$/);
    if (dmAttachmentMatch) {
      const id = decodeURIComponent(dmAttachmentMatch[1]);
      if (request.method === 'POST') {
        const body = await request.json();
        await enqueueWaAction(env, {
          actionId: `act_${Date.now()}_att_${id}`,
          type: 'attach_file',
          payload: { id, ...body }
        });
        return jsonResponse({ success: true });
      }
      if (request.method === 'DELETE') {
        await enqueueWaAction(env, {
          actionId: `act_${Date.now()}_rmatt_${id}`,
          type: 'remove_file',
          payload: { id }
        });
        return jsonResponse({ success: true });
      }
    }

    const dmItemMatch = url.pathname.match(/^\/api\/direct-messages\/([^/]+)$/);
    if (dmItemMatch) {
      const id = decodeURIComponent(dmItemMatch[1]);
      if (request.method === 'PUT') {
        const body = await request.json();
        await enqueueWaAction(env, {
          actionId: `act_${Date.now()}_upd_${id}`,
          type: 'update_message',
          payload: { id, data: body }
        });
        return jsonResponse({ success: true });
      }
      if (request.method === 'DELETE') {
        await enqueueWaAction(env, {
          actionId: `act_${Date.now()}_del_${id}`,
          type: 'delete_message',
          payload: { id }
        });
        return jsonResponse({ success: true });
      }
    }

    // 7. Arquivos estáticos (public/index.html)
    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      const newHeaders = new Headers(assetRes.headers);
      newHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      return new Response(assetRes.body, {
        status: assetRes.status,
        headers: newHeaders
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

