const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const whatsappService = require('./whatsappService');
const { markLeadContactedByPhone } = require('./leadRepository');

const DM_FILE = path.join(__dirname, '..', 'data', 'direct_messages.json');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads', 'attachments');

function formatNowBR() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

class SenderService extends EventEmitter {
  constructor() {
    super();
    this.ensureDirs();
    this.data = this.load();
    this.isBatchRunning = false;
    this.isPaused = false;
    this.currentBatchIndex = 0;
    this.totalBatchCount = 0;
    this.currentDelayCountdown = 0;
    this.activeTimeout = null;
  }

  ensureDirs() {
    const dataDir = path.dirname(DM_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
  }

  load() {
    try {
      if (fs.existsSync(DM_FILE)) {
        const raw = fs.readFileSync(DM_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.messages)) {
          if (!parsed.settings) {
            parsed.settings = { delayMinSeconds: 6, delayMaxSeconds: 12 };
          }
          this.data = parsed;
          return parsed;
        }
      }
    } catch (err) {
      console.error('[Sender 1a1] Erro ao ler direct_messages.json:', err.message);
    }

    const defaultData = {
      settings: { delayMinSeconds: 6, delayMaxSeconds: 12 },
      messages: []
    };
    this.save(defaultData);
    return defaultData;
  }

  save(data = this.data) {
    try {
      this.ensureDirs();
      this.data = data;
      fs.writeFileSync(DM_FILE, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error('[Sender 1a1] Erro ao salvar direct_messages.json:', err.message);
      return false;
    }
  }

  getMessages() {
    return this.data.messages || [];
  }

  getSettings() {
    return this.data.settings || { delayMinSeconds: 6, delayMaxSeconds: 12 };
  }

  updateSettings(settings) {
    this.data.settings = { ...this.getSettings(), ...settings };
    this.save();
    return this.data.settings;
  }

  getStats() {
    const msgs = this.getMessages();
    return {
      total: msgs.length,
      sent: msgs.filter((m) => m.status === 'sent').length,
      pending: msgs.filter((m) => m.status === 'pending').length,
      sending: msgs.filter((m) => m.status === 'sending').length,
      failed: msgs.filter((m) => m.status === 'failed').length,
      isBatchRunning: this.isBatchRunning,
      isPaused: this.isPaused,
      currentBatchIndex: this.currentBatchIndex,
      totalBatchCount: this.totalBatchCount,
      currentDelayCountdown: this.currentDelayCountdown
    };
  }

  addMessage(data) {
    const newId = 'dm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const newMsg = {
      id: newId,
      name: (data.name || 'Cliente').trim(),
      socio: (data.socio || '').trim(),
      phone: (data.phone || '').trim(),
      message: (data.message || '').trim(),
      attachment: data.attachment || null,
      status: 'pending',
      sentAt: null,
      error: null
    };
    this.data.messages.push(newMsg);
    this.save();
    this.emit('stats_update', this.getStats());
    return newMsg;
  }

  /**
   * Importa múltiplos contatos (ex.: vindos do Buscador de Leads Google) para a fila de Disparo 1 a 1
   */
  bulkImportContacts(contacts = []) {
    if (!Array.isArray(contacts)) return { addedCount: 0, total: this.getMessages().length };

    const existingPhones = new Set(
      this.getMessages().map((m) => (m.phone || '').replace(/\D/g, '')).filter(Boolean)
    );

    let addedCount = 0;
    for (const item of contacts) {
      const cleanPhone = (item.phone || '').replace(/\D/g, '');
      if (!cleanPhone) continue;
      if (existingPhones.has(cleanPhone)) continue;

      existingPhones.add(cleanPhone);
      const newId = 'dm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      this.data.messages.push({
        id: newId,
        name: (item.name || 'Estabelecimento').trim(),
        socio: (item.socio || '').trim(),
        phone: (item.phone || '').trim(),
        message: (item.message || '').trim(),
        attachment: null,
        status: 'pending',
        sentAt: null,
        error: null
      });
      addedCount++;
    }

    if (addedCount > 0) {
      this.save();
      this.emit('stats_update', this.getStats());
    }

    return { addedCount, total: this.getMessages().length };
  }

  updateMessage(id, data) {
    const msg = this.getMessages().find((m) => m.id === id);
    if (!msg) return null;

    if (data.name !== undefined) msg.name = data.name.trim();
    if (data.phone !== undefined) msg.phone = data.phone.trim();
    if (data.message !== undefined) msg.message = data.message.trim();
    if (data.status !== undefined) msg.status = data.status;

    this.save();
    this.emit('stats_update', this.getStats());
    return msg;
  }

  /**
   * Salva arquivo físico (PDF, PNG, JPG, JPEG, WEBP, GIF) e vincula ao contato.
   */
  attachFileFromBase64(id, { fileName, fileBase64, mimeType }) {
    const msg = this.getMessages().find((m) => m.id === id);
    if (!msg) {
      throw new Error('Contato não encontrado.');
    }

    // Extrai mimeType do data URL caso presente
    let detectedMime = mimeType || '';
    const dataUrlMatch = /^data:([^;]+);base64,/i.exec(fileBase64 || '');
    if (dataUrlMatch) {
      detectedMime = dataUrlMatch[1];
    }

    const cleanBase64 = (fileBase64 || '').replace(/^data:[^;]+;base64,/i, '');
    const buffer = Buffer.from(cleanBase64, 'base64');

    if (buffer.length === 0) {
      throw new Error('Arquivo vazio ou inválido.');
    }

    // Remove anexo antigo se existir
    this.deleteAttachmentFileOnDisk(msg);

    const safeOriginalName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storedFileName = `${id}_${Date.now()}_${safeOriginalName}`;
    const filePath = path.join(UPLOADS_DIR, storedFileName);

    fs.writeFileSync(filePath, buffer);

    const ext = path.extname(fileName).toLowerCase();
    const isImage =
      detectedMime.startsWith('image/') ||
      ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);

    msg.attachment = {
      fileName: fileName.trim(),
      storedFileName,
      filePath,
      mimeType: detectedMime || (isImage ? 'image/png' : 'application/pdf'),
      fileType: isImage ? 'image' : 'pdf',
      size: buffer.length,
      attachedAt: formatNowBR()
    };

    this.save();
    this.emit('message_status', { id, status: msg.status, msg });
    return msg;
  }

  deleteAttachmentFileOnDisk(msg) {
    if (msg && msg.attachment && msg.attachment.filePath) {
      try {
        const oldPath = path.isAbsolute(msg.attachment.filePath)
          ? msg.attachment.filePath
          : path.join(__dirname, '..', msg.attachment.filePath);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      } catch (e) {
        console.warn(`[Sender 1a1] Falha ao remover arquivo antigo: ${e.message}`);
      }
    }
  }

  removeFile(id) {
    const msg = this.getMessages().find((m) => m.id === id);
    if (!msg) return null;

    this.deleteAttachmentFileOnDisk(msg);
    msg.attachment = null;
    this.save();
    this.emit('message_status', { id, status: msg.status, msg });
    return msg;
  }

  deleteMessage(id) {
    const msg = this.getMessages().find((m) => m.id === id);
    if (msg) {
      this.deleteAttachmentFileOnDisk(msg);
    }

    const initialLen = this.data.messages.length;
    this.data.messages = this.data.messages.filter((m) => m.id !== id);
    if (this.data.messages.length !== initialLen) {
      this.save();
      this.emit('stats_update', this.getStats());
      return true;
    }
    return false;
  }

  clearAll() {
    if (this.isBatchRunning) {
      this.pauseBatchSend();
    }
    for (const msg of this.getMessages()) {
      this.deleteAttachmentFileOnDisk(msg);
    }
    this.data.messages = [];
    this.save();
    this.emit('stats_update', this.getStats());
    return { success: true };
  }

  async sendSingle(id) {
    const msg = this.getMessages().find((m) => m.id === id);
    if (!msg) {
      throw new Error(`Contato com ID "${id}" não encontrado.`);
    }

    if (whatsappService.status !== 'connected') {
      throw new Error('WhatsApp não está conectado. Escaneie o QR Code na aba Sender antes de disparar.');
    }

    msg.status = 'sending';
    this.emit('message_status', { id, status: 'sending', msg });

    try {
      const jid = await whatsappService.resolveJid(msg.phone);
      const resolvedText = (msg.message || '')
        .replace(/\{nome\}/gi, msg.name || '')
        .replace(/\{socio\}/gi, msg.socio || msg.name || 'parceiro');

      let hasAttachment = false;
      let attachmentPath = null;

      if (msg.attachment && msg.attachment.filePath) {
        attachmentPath = path.isAbsolute(msg.attachment.filePath)
          ? msg.attachment.filePath
          : path.join(__dirname, '..', msg.attachment.filePath);

        if (fs.existsSync(attachmentPath)) {
          hasAttachment = true;
        }
      }

      if (hasAttachment) {
        await whatsappService.sendMedia(
          jid,
          attachmentPath,
          msg.attachment.fileName,
          msg.attachment.mimeType,
          resolvedText
        );
      } else {
        await whatsappService.sendMessage(jid, resolvedText);
      }

      msg.status = 'sent';
      msg.sentAt = formatNowBR();
      msg.error = null;
      this.save();

      // Marca automaticamente o lead correspondente no CRM como "contacted"
      const updatedLead = markLeadContactedByPhone(msg.phone);
      if (updatedLead) {
        this.emit('lead_contacted', updatedLead);
      }

      console.log(`[Sender 1a1] ✅ Disparo enviado para ${msg.name} (${msg.phone})`);
      this.emit('message_status', { id, status: 'sent', msg });
      this.emit('stats_update', this.getStats());
      return { success: true, msg };
    } catch (err) {
      msg.status = 'failed';
      msg.error = err.message || 'Erro ao enviar no WhatsApp';
      this.save();

      console.error(`[Sender 1a1] ❌ Falha ao enviar para ${msg.name}:`, err.message);
      this.emit('message_status', { id, status: 'failed', msg });
      this.emit('stats_update', this.getStats());
      throw err;
    }
  }

  async startBatchSend() {
    if (this.isBatchRunning) {
      return { alreadyRunning: true, stats: this.getStats() };
    }

    if (whatsappService.status !== 'connected') {
      throw new Error('WhatsApp não está conectado. Escaneie o QR Code primeiro.');
    }

    const pending = this.getMessages().filter((m) => m.status === 'pending' || m.status === 'failed');
    if (pending.length === 0) {
      return { noPending: true, stats: this.getStats() };
    }

    this.isBatchRunning = true;
    this.isPaused = false;
    this.totalBatchCount = pending.length;
    this.currentBatchIndex = 0;
    this.emit('batch_start', { total: pending.length });
    this.emit('stats_update', this.getStats());

    (async () => {
      for (let i = 0; i < pending.length; i++) {
        if (!this.isBatchRunning || this.isPaused) {
          break;
        }

        const item = pending[i];
        this.currentBatchIndex = i + 1;
        this.emit('batch_progress', {
          current: this.currentBatchIndex,
          total: this.totalBatchCount,
          item
        });

        try {
          await this.sendSingle(item.id);
        } catch {
          // Continua para o próximo mesmo se um falhar
        }

        if (i < pending.length - 1 && this.isBatchRunning && !this.isPaused) {
          const min = this.getSettings().delayMinSeconds || 6;
          const max = this.getSettings().delayMaxSeconds || 12;
          const delaySec = Math.floor(Math.random() * (max - min + 1)) + min;

          for (let sec = delaySec; sec > 0; sec--) {
            if (!this.isBatchRunning || this.isPaused) break;
            this.currentDelayCountdown = sec;
            this.emit('delay_countdown', { seconds: sec, nextContact: pending[i + 1]?.name });
            await new Promise((r) => {
              this.activeTimeout = setTimeout(r, 1000);
            });
          }
          this.currentDelayCountdown = 0;
        }
      }

      this.isBatchRunning = false;
      this.isPaused = false;
      this.currentDelayCountdown = 0;
      this.emit('batch_end', this.getStats());
      this.emit('stats_update', this.getStats());
    })();

    return { started: true, total: pending.length };
  }

  pauseBatchSend() {
    this.isPaused = true;
    this.isBatchRunning = false;
    if (this.activeTimeout) {
      clearTimeout(this.activeTimeout);
      this.activeTimeout = null;
    }
    this.currentDelayCountdown = 0;
    this.emit('batch_paused', this.getStats());
    this.emit('stats_update', this.getStats());
    return { success: true };
  }

  resetStatus() {
    if (this.isBatchRunning) {
      this.pauseBatchSend();
    }
    const msgs = this.getMessages();
    for (const m of msgs) {
      m.status = 'pending';
      m.sentAt = null;
      m.error = null;
    }
    this.save();
    this.emit('stats_update', this.getStats());
    return { success: true, count: msgs.length };
  }
}

const senderService = new SenderService();
module.exports = senderService;

