const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const AUTH_DIR = path.join(__dirname, '..', 'auth_info_baileys');

function inferMimeType(fileName = '', explicitMime = '') {
  if (explicitMime && typeof explicitMime === 'string' && explicitMime.includes('/')) {
    return explicitMime;
  }
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.status = 'disconnected'; // 'disconnected', 'connecting', 'qr_ready', 'connected'
    this.currentQrDataUrl = null;
    this.currentRawQr = null;
    this.qrGeneratedAt = null;
    this.userProfile = null;
    this.reconnectTimeout = null;
    this.isInitializing = false;
  }

  async init() {
    if (this.isInitializing) return;
    this.isInitializing = true;

    try {
      clearTimeout(this.reconnectTimeout);

      // Fecha socket anterior com segurança antes de criar um novo
      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners('connection.update');
          this.sock.ev.removeAllListeners('creds.update');
          this.sock.end(undefined);
        } catch {}
        this.sock = null;
      }

      this.status = 'connecting';
      this.emit('status_change', { status: this.status });
      console.log('[WhatsApp Sender] Iniciando conexão com WhatsApp Web (Baileys)...');

      if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version, isLatest } = await fetchLatestBaileysVersion();
      const silentLogger = pino({ level: 'silent' });
      console.log(`[WhatsApp Sender] Versão WhatsApp Web: ${version.join('.')} (Última: ${isLatest})`);

      const authPayload =
        typeof makeCacheableSignalKeyStore === 'function'
          ? {
              creds: state.creds,
              keys: makeCacheableSignalKeyStore(state.keys, silentLogger)
            }
          : state;

      const sock = makeWASocket({
        version,
        auth: authPayload,
        logger: silentLogger,
        printQRInTerminal: false,
        browser: Browsers && typeof Browsers.ubuntu === 'function' ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
      });

      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.currentRawQr = qr;
          this.qrGeneratedAt = Date.now();
          this.status = 'qr_ready';
          try {
            this.currentQrDataUrl = await qrcode.toDataURL(qr, {
              margin: 2,
              scale: 8,
              color: {
                dark: '#0f172a',
                light: '#ffffff'
              }
            });
          } catch (e) {
            console.error('[WhatsApp Sender] Erro ao converter QR Code:', e.message);
          }

          console.log('\n======================================================');
          console.log('  ESCANEIE O QR CODE NO PAINEL WEB (ABA SENDER 1 A 1)');
          console.log('======================================================\n');
          try {
            qrcodeTerminal.generate(qr, { small: true });
          } catch {
            // ignore terminal qr errors
          }

          this.emit('qr', { qrDataUrl: this.currentQrDataUrl, raw: qr, generatedAt: this.qrGeneratedAt });
          this.emit('status_change', { status: this.status, hasQr: true });
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
          const isBadSession =
            statusCode === DisconnectReason.loggedOut ||
            statusCode === DisconnectReason.badSession ||
            statusCode === 401 ||
            statusCode === 403 ||
            statusCode === 405 ||
            statusCode === 500;

          console.warn(`[WhatsApp Sender] Conexão encerrada (Código: ${statusCode}).`);

          if (isRestartRequired) {
            // Reconexão imediata obrigatória após leitura do QR Code (Código 515) para concluir pareamento no celular
            console.log('[WhatsApp Sender] Pareamento lido (515)! Reconectando imediatamente para concluir vínculo...');
            clearTimeout(this.reconnectTimeout);
            this.isInitializing = false;
            this.reconnectTimeout = setTimeout(() => {
              this.init();
            }, 150);
            return;
          }

          this.status = 'disconnected';
          this.currentQrDataUrl = null;
          this.currentRawQr = null;
          this.qrGeneratedAt = null;
          this.emit('status_change', { status: this.status });

          if (isBadSession) {
            console.warn('[WhatsApp Sender] Sessão inválida ou desconectada. Limpando credenciais e gerando novo QR Code...');
            this.clearAuthAndRestart();
          } else {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = setTimeout(() => {
              this.isInitializing = false;
              this.init();
            }, 1500);
          }
        } else if (connection === 'open') {
          this.status = 'connected';
          this.currentQrDataUrl = null;
          this.currentRawQr = null;
          this.qrGeneratedAt = null;

          const user = sock.user;
          this.userProfile = {
            id: user?.id,
            name: user?.name || user?.notify || 'WhatsApp Conectado',
            phone: user?.id ? user.id.split(':')[0] : ''
          };

          console.log(`[WhatsApp Sender] Conectado com sucesso: ${this.userProfile.name} (+${this.userProfile.phone})`);
          this.emit('status_change', { status: this.status, user: this.userProfile });
        }
      });
    } catch (err) {
      console.error('[WhatsApp Sender] Erro ao inicializar WhatsApp:', err.message);
      this.status = 'disconnected';
      this.emit('status_change', { status: this.status, error: err.message });
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = setTimeout(() => {
        this.isInitializing = false;
        this.init();
      }, 3000);
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Gera código de pareamento de 8 dígitos para conectar via número de telefone (sem precisar da câmera).
   * @param {string} rawPhone
   * @returns {Promise<string>}
   */
  async requestPairingCode(rawPhone) {
    let clean = String(rawPhone || '').replace(/\D/g, '');
    if (!clean) {
      throw new Error('Informe o número do WhatsApp com DDD.');
    }
    if (!clean.startsWith('55') && (clean.length === 10 || clean.length === 11)) {
      clean = '55' + clean;
    }
    if (clean.length < 12 || clean.length > 13) {
      throw new Error('Número inválido. Digite DDD + Número (ex: 11 99999-8888).');
    }

    if (!this.sock || this.status === 'connected') {
      throw new Error('Aguarde o gerador de conexão iniciar ou desconecte a sessão atual.');
    }

    const code = await this.sock.requestPairingCode(clean);
    const formattedCode = code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    return formattedCode;
  }

  async resolveJid(phone) {
    let clean = (phone || '').replace(/\D/g, '');
    if (!clean) {
      throw new Error('Número de telefone inválido ou vazio.');
    }
    if (!clean.startsWith('55') && clean.length <= 11) {
      clean = '55' + clean;
    }

    if (this.sock && this.status === 'connected') {
      try {
        const results = await this.sock.onWhatsApp(clean);
        if (results && results.length > 0 && results[0].exists) {
          return results[0].jid;
        }
      } catch (err) {
        console.warn(`[WhatsApp Sender] Consulta onWhatsApp para [${clean}] falhou: ${err.message}. Usando JID padrão.`);
      }
    }

    return `${clean}@s.whatsapp.net`;
  }

  /**
   * Verifica no WhatsApp Web (via Baileys onWhatsApp) quais números possuem conta de WhatsApp ativa.
   * @param {string[]} phones
   * @returns {Promise<{ connected: boolean, results: Record<string, boolean> }>}
   */
  async verifyNumbersOnWhatsApp(phones = []) {
    if (!this.sock || this.status !== 'connected') {
      return { connected: false, results: {} };
    }

    const results = {};
    for (const raw of phones) {
      const digits = String(raw || '').replace(/\D/g, '').replace(/^55/, '');
      if (!digits || (digits.length !== 10 && digits.length !== 11)) continue;

      const fullNumber = `55${digits}`;
      try {
        const check = await this.sock.onWhatsApp(fullNumber);
        results[digits] = Boolean(check && check.length > 0 && check[0].exists);
      } catch {
        results[digits] = null;
      }
    }

    return { connected: true, results };
  }

  async sendMessage(jid, text) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp não está conectado. Escaneie o QR Code antes de enviar.');
    }

    const result = await this.sock.sendMessage(jid, { text: text || '' });
    return result;
  }

  /**
   * Envia arquivo de mídia (Imagem PNG/JPG/WEBP/GIF ou Documento PDF) com a mensagem como legenda.
   */
  async sendMedia(jid, filePath, fileName, explicitMimeType = '', caption = '') {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp não está conectado. Escaneie o QR Code antes de enviar.');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`Arquivo anexado não encontrado: ${fileName}`);
    }

    const resolvedFileName = fileName || path.basename(filePath);
    const mimeType = inferMimeType(resolvedFileName, explicitMimeType);
    const fileBuffer = fs.readFileSync(filePath);

    let payload;
    if (mimeType.startsWith('image/')) {
      payload = {
        image: fileBuffer,
        mimetype: mimeType,
        caption: caption || ''
      };
    } else {
      payload = {
        document: fileBuffer,
        mimetype: mimeType,
        fileName: resolvedFileName,
        caption: caption || ''
      };
    }

    const result = await this.sock.sendMessage(jid, payload);
    return result;
  }

  async clearAuthAndRestart() {
    clearTimeout(this.reconnectTimeout);

    try {
      if (this.sock) {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.end(undefined);
      }
    } catch {
      // ignore
    }
    this.sock = null;

    await new Promise((r) => setTimeout(r, 600));

    try {
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        console.log('[WhatsApp Sender] Credenciais de sessão removidas.');
      }
    } catch (e) {
      console.error('[WhatsApp Sender] Erro ao limpar pasta de autenticação:', e.message);
    }

    this.status = 'disconnected';
    this.currentQrDataUrl = null;
    this.currentRawQr = null;
    this.userProfile = null;
    this.emit('status_change', { status: this.status });

    setTimeout(() => {
      this.isInitializing = false;
      this.init();
    }, 1500);
  }

  getStatus() {
    return {
      status: this.status,
      user: this.userProfile,
      hasQr: Boolean(this.currentQrDataUrl)
    };
  }
}

const whatsappService = new WhatsAppService();
module.exports = whatsappService;

