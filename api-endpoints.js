// =====================================================
// MINI APP API — adicione este bloco no seu index.js
// LOGO APÓS as linhas de require() no topo do arquivo
// =====================================================

// 1. Instale as dependências (no package.json adicione):
//    "express": "^4.18.2",
//    "cors": "^2.8.5"
//
// 2. Adicione no topo do index.js (junto com os outros requires):
//    const express = require('express');
//    const cors = require('cors');
//    const crypto = require('crypto');
//
// 3. Cole TODO o bloco abaixo logo depois dos requires:

// ===== EXPRESS API PARA O MINI APP =====
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const moment_api = require('moment');

const apiApp = express();
apiApp.use(cors()); // Permite o Vercel chamar a API
apiApp.use(express.json({ limit: '10mb' })); // Suporte a base64 de fotos

const BOT_TOKEN_FOR_VALIDATION = process.env.BOT_TOKEN || 'SEU_TOKEN_AQUI';
const API_PORT = process.env.API_PORT || 3001;

// ----- Helper: validar initData do Telegram -----
function validateTelegramInitData(initData) {
  if (!initData) return true; // Em dev, pula validação
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN_FOR_VALIDATION).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return expectedHash === hash;
  } catch { return true; }
}

// ----- Helper: ler/salvar DB -----
function lerDB_api() {
  try { return JSON.parse(require('fs').readFileSync('./database.json')); } catch { return {}; }
}
function salvarDB_api(data) {
  require('fs').writeFileSync('./database.json', JSON.stringify(data, null, 2));
}

// ----- Helper: verificar se é admin/atendente -----
function isAdminOrAgent(userId, db) {
  const admins = [OWNER_ID, ...(db.config?.admin_ids || [])];
  const agents = Object.keys(db.support_agents || {});
  return admins.includes(Number(userId)) || admins.includes(String(userId)) || agents.includes(String(userId));
}

// ----- GET /api/init -----
// Retorna o papel do usuário (client ou attendant)
apiApp.get('/api/init', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const db = lerDB_api();
  const role = isAdminOrAgent(userId, db) ? 'attendant' : 'client';
  const user = db.users?.[userId] || {};

  res.json({
    role,
    name: user.nome || 'Usuário',
    balance: user.saldo || 0
  });
});

// ----- GET /api/tickets -----
// Lista tickets (client vê os seus, attendant vê todos)
apiApp.get('/api/tickets', (req, res) => {
  const { userId, role, status } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const db = lerDB_api();
  let tickets = db.support_tickets || [];

  // Filtrar por usuário se for cliente
  if (role !== 'attendant') {
    tickets = tickets.filter(t => String(t.user_id) === String(userId));
  }

  // Filtrar por status
  if (status === 'open') {
    tickets = tickets.filter(t => t.status === 'open');
  } else if (status === 'in_progress') {
    tickets = tickets.filter(t => t.status === 'in_progress');
  } else if (status === 'resolved') {
    tickets = tickets.filter(t => t.status === 'resolved' || t.status === 'closed');
  }

  // Ordenar do mais recente
  tickets.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Mapear para resposta limpa
  const result = tickets.map(t => {
    const lastMsg = t.messages?.[t.messages.length - 1];
    return {
      id: t.id,
      user_id: t.user_id,
      category: t.category,
      status: t.status,
      created_at: t.created_at,
      messages_count: t.messages?.length || 0,
      last_message: lastMsg?.photo_id ? '📷 Imagem' : lastMsg?.text || '',
      assigned_to: t.assigned_to
    };
  });

  res.json({ tickets: result });
});

// ----- GET /api/ticket/:id -----
// Detalhes de um ticket com todas as mensagens
apiApp.get('/api/ticket/:id', (req, res) => {
  const { userId, role } = req.query;
  const db = lerDB_api();

  const ticket = db.support_tickets?.find(t => {
    if (t.id !== req.params.id) return false;
    // Cliente só vê o próprio ticket
    if (role !== 'attendant' && String(t.user_id) !== String(userId)) return false;
    return true;
  });

  if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado' });

  res.json({ ticket });
});

// ----- POST /api/ticket -----
// Criar novo ticket
apiApp.post('/api/ticket', async (req, res) => {
  const { userId, userName, category, description, initData } = req.body;
  if (!userId || !category || !description) {
    return res.status(400).json({ error: 'Campos obrigatórios: userId, category, description' });
  }

  const db = lerDB_api();
  if (!db.support_tickets) db.support_tickets = [];

  const ticketId = `TICKET_${moment_api().utcOffset(-3).format('YYYYMMDD_HHmmss')}`;
  const now = moment_api().utcOffset(-3).toDate();

  db.support_tickets.push({
    id: ticketId,
    user_id: Number(userId),
    user_name: (userName || 'Usuário').split(' ')[0],
    created_at: now,
    status: 'open',
    category,
    description,
    assigned_to: null,
    messages: [{
      from: Number(userId),
      from_name: (userName || 'Usuário').split(' ')[0],
      text: description,
      timestamp: now
    }],
    resolved_at: null,
    rating: null
  });

  salvarDB_api(db);

  // Notificar admins via bot
  try {
    const adminIds = [OWNER_ID, ...(db.config?.admin_ids || [])].filter((v,i,a) => a.indexOf(v) === i);
    const catLabel = { produto:'📦 Produto', pagamento:'💳 Pagamento', tecnico:'⚙️ Técnico', outro:'❓ Outro' };
    const k = { inline_keyboard: [[{text: '🎫 Ver Ticket', callback_data: 'atendimento_painel'}]] };
    adminIds.forEach(adminId => {
      bot.sendMessage(adminId,
        `🆕 <b>NOVO TICKET (Mini App)</b>\n\n🎫 ${ticketId}\n📂 ${catLabel[category] || category}\n👤 ID: ${userId}\n\n<i>"${description.slice(0,80)}"</i>`,
        { parse_mode: 'HTML', reply_markup: k }
      ).catch(() => {});
    });
  } catch(e) {}

  res.json({ ticketId, success: true });
});

// ----- POST /api/ticket/:id/message -----
// Enviar mensagem num ticket
apiApp.post('/api/ticket/:id/message', async (req, res) => {
  const { userId, userName, text, photo, role, initData } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!text && !photo) return res.status(400).json({ error: 'text ou photo obrigatório' });

  const db = lerDB_api();
  const ticket = db.support_tickets?.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado' });

  // Verificar permissão
  const isAttendant = isAdminOrAgent(userId, db);
  if (!isAttendant && String(ticket.user_id) !== String(userId)) {
    return res.status(403).json({ error: 'Sem permissão' });
  }

  const msgEntry = {
    from: Number(userId),
    from_name: (userName || 'Usuário').split(' ')[0],
    text: text || (photo ? '📷 Imagem enviada' : ''),
    timestamp: moment_api().utcOffset(-3).toDate()
  };

  // Processar foto (base64 → enviar pelo bot e guardar file_id)
  if (photo) {
    try {
      // Salvar base64 em arquivo temporário e enviar via bot
      const fs = require('fs');
      const tmpPath = `/tmp/photo_${Date.now()}.jpg`;
      fs.writeFileSync(tmpPath, Buffer.from(photo, 'base64'));

      // Enviar para um chat dummy (o próprio user) para pegar o file_id
      const sentPhoto = await bot.sendPhoto(userId, fs.createReadStream(tmpPath), { caption: '📷' });
      const fileId = sentPhoto.photo[sentPhoto.photo.length - 1].file_id;
      msgEntry.photo_id = fileId;

      // Limpar arquivo temporário
      fs.unlinkSync(tmpPath);

      // Apagar a mensagem de preview
      await bot.deleteMessage(userId, sentPhoto.message_id).catch(() => {});
    } catch(e) {
      console.error('Erro ao processar foto:', e.message);
    }
  }

  ticket.messages.push(msgEntry);
  ticket.last_activity = moment_api().utcOffset(-3).toDate();
  salvarDB_api(db);

  // Notificar o outro lado via bot (atualizar janela de chat se existir)
  try {
    if (isAttendant && ticket.client_chat_msg_id) {
      const { buildChatWindow_simple } = require('./supportSystem');
      // Notificação simples para o cliente
      bot.sendMessage(ticket.user_id,
        `💬 <b>Nova resposta do atendente!</b>\n\n${text || '📷 Imagem'}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    } else if (!isAttendant && ticket.assigned_to) {
      bot.sendMessage(ticket.assigned_to,
        `💬 <b>Nova mensagem do cliente!</b>\n\n🆔 ${ticket.user_id}\n${text || '📷 Imagem'}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  } catch(e) {}

  res.json({ success: true });
});

// ----- POST /api/ticket/:id/take -----
// Atendente pegar ticket
apiApp.post('/api/ticket/:id/take', async (req, res) => {
  const { userId, userName } = req.body;
  const db = lerDB_api();

  if (!isAdminOrAgent(userId, db)) {
    return res.status(403).json({ error: 'Sem permissão' });
  }

  const ticket = db.support_tickets?.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Não encontrado' });
  if (ticket.status !== 'open') return res.status(400).json({ error: 'Ticket já está sendo atendido' });

  ticket.status = 'in_progress';
  ticket.assigned_to = Number(userId);
  ticket.assigned_name = (userName || 'Atendente').split(' ')[0];
  ticket.assigned_at = moment_api().utcOffset(-3).toDate();
  salvarDB_api(db);

  // Notificar cliente
  bot.sendMessage(ticket.user_id,
    `🧑‍💼 <b>Atendente entrou no chat!</b>\n\n🎫 ${ticket.id}\n\nVocê pode responder agora!`,
    { parse_mode: 'HTML' }
  ).catch(() => {});

  res.json({ success: true });
});

// ----- POST /api/ticket/:id/resolve -----
// Resolver ticket
apiApp.post('/api/ticket/:id/resolve', async (req, res) => {
  const { userId } = req.body;
  const db = lerDB_api();

  if (!isAdminOrAgent(userId, db)) {
    return res.status(403).json({ error: 'Sem permissão' });
  }

  const ticket = db.support_tickets?.find(t => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Não encontrado' });

  ticket.status = 'resolved';
  ticket.resolved_at = moment_api().utcOffset(-3).toDate();
  salvarDB_api(db);

  // Notificar cliente
  bot.sendMessage(ticket.user_id,
    `✅ <b>Ticket resolvido!</b>\n\n🎫 ${ticket.id}\n\nSeu chamado foi encerrado. Obrigado!`,
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '⭐ Avaliar Atendimento', callback_data: `ticket_rate_${ticket.id}` }]] }
    }
  ).catch(() => {});

  res.json({ success: true });
});

// ----- Iniciar servidor -----
apiApp.listen(API_PORT, () => {
  console.log(`🌐 Mini App API rodando na porta ${API_PORT}`);
});

// =====================================================
// FIM DO BLOCO DA API
// =====================================================
