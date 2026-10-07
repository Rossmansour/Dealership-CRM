// messages-ui.js -- Messages (CRM Domus): every text conversation in one
// place, like the messages app on a phone. Texts go out from your own
// number; customers' replies show up here as they arrive. Loaded after app.js.

let msgData = null;          // { conversations, myNumber, unread }
let msgScope = 'mine';
let msgOpenId = null;        // the conversation on screen
let msgTimer = null;
let msgAttach = [];          // photos / videos waiting to send

async function openMessagesView() {
  document.getElementById('msgScope').hidden = !userCan('viewAllReports');
  await loadMessages();
  stopMessagesPolling();
  // New texts show up on their own while this screen is open.
  msgTimer = setInterval(() => { if (!document.hidden) loadMessages(true); }, 15000);
}
function stopMessagesPolling() { clearInterval(msgTimer); msgTimer = null; }

async function loadMessages(quiet = false) {
  try {
    const res = await fetch(`${API}/messages?scope=${msgScope}`);
    if (!res.ok) return;
    const fresh = await res.json();
    const changed = !msgData || JSON.stringify(fresh.conversations.map(c => [c.leadId, c.last.date, c.unread])) !== JSON.stringify(msgData.conversations.map(c => [c.leadId, c.last.date, c.unread]));
    msgData = fresh;
    if (changed || !quiet) {
      // The customer records carry the texts themselves.
      leads = await (await fetch(`${API}/leads`)).json();
      renderMsgList();
      if (msgOpenId) renderMsgThread(false);
      renderRail();
      renderPipelineTiles();
    }
  } catch (err) { /* try again next time */ }
}

function renderMsgList() {
  document.getElementById('msgMyNumber').textContent = msgData.myNumber
    ? `Your number: ${fmtPhone(msgData.myNumber)}`
    : "You don't have your own number yet -- texts go out from the store's. (Admin → Users)";
  const q = document.getElementById('msgSearch').value.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const list = msgData.conversations.filter(c => !q || c.name.toLowerCase().includes(q) || (digits.length >= 3 && c.phone.replace(/\D/g, '').includes(digits)));
  document.getElementById('msgList').innerHTML = list.length ? list.map(c => html`
    <button type="button" class="msg-row ${c.leadId === msgOpenId ? 'active' : ''} ${c.unread ? 'unread' : ''}" data-msg-open="${c.leadId}">
      <span class="msg-avatar">${initials(c.name)}</span>
      <span class="msg-row-main">
        <span class="msg-row-top"><strong>${c.name}</strong><span class="msg-when">${msgWhen(c.last.date)}</span></span>
        <span class="msg-preview">${c.last.direction === 'in' ? '' : 'You: '}${c.last.message || (c.last.photo ? '📷 Photo / video' : '')}</span>
      </span>
      ${c.unread ? html`<span class="msg-unread">${c.unread}</span>` : ''}
    </button>`).join('') : html`<p class="audit-note msg-none">${q ? 'No conversations match.' : 'No texts yet. Text a customer from their page, or wait for one to text your number.'}</p>`;
}

const fmtPhone = p => String(p || '').replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
function msgWhen(iso) {
  const d = new Date(iso);
  return isToday(iso) ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function openConversation(leadId) {
  msgOpenId = leadId;
  msgAttach = [];
  document.getElementById('msgLayout').classList.add('thread-open');
  renderMsgList();
  renderMsgThread(true);
  const c = msgData.conversations.find(x => x.leadId === leadId);
  if (c && c.unread) {
    await fetch(`${API}/leads/${leadId}/texts/read`, { method: 'POST' });
    c.unread = 0;
    const l = leads.find(x => x.id === leadId);
    if (l) l.unreadTexts = 0;
    renderMsgList();
    renderRail();
    renderPipelineTiles();
  }
}

function renderMsgThread(scrollToEnd) {
  const pane = document.getElementById('msgThreadPane');
  const lead = leads.find(l => l.id === msgOpenId);
  if (!lead) { pane.innerHTML = html`<div class="msg-empty">Pick a conversation.</div>`; return; }
  const draft = document.getElementById('msgInput') ? document.getElementById('msgInput').value : '';
  const texts = (lead.activities || []).filter(a => a.type === 'text' || (a.type === 'video' && a.direction)).slice().reverse();
  const views = token => ((lead.media || []).find(m => m.token === token) || {}).views || 0;
  pane.innerHTML = html`
    <div class="msg-thread-head">
      <button type="button" class="btn-secondary btn-small msg-back" data-msg-back aria-label="Back to conversations">←</button>
      <span class="msg-avatar">${initials(lead.name)}</span>
      <div class="msg-thread-who"><strong>${lead.name}</strong><span class="audit-note">${fmtPhone(lead.phone) || 'No phone'}</span></div>
      <button type="button" class="btn-secondary btn-small" data-msg-customer title="Open their customer page">Customer</button>
    </div>
    <div class="msg-bubbles" id="msgBubbles">
      ${texts.map(t => html`<div class="cp-bubble ${t.direction === 'in' ? 'in' : 'out'}">
        ${t.message !== undefined ? (t.message ? html`<div>${t.message}</div>` : '') : html`<div>${t.text}</div>`}
        ${(t.photos || (t.photo ? [t.photo] : [])).map(p => html`<a href="${p}" target="_blank" rel="noopener"><img src="${photoThumb(p, 180, 135)}" alt="" loading="lazy" /></a>`)}
        ${(t.videos || []).map(v => html`<a class="cp-bubble-video" href="/v/${v.token}" target="_blank" rel="noopener">🎥 Video · ${views(v.token) ? 'watched' : 'not watched yet'}</a>`)}
        <div class="cp-bubble-meta">${t.direction === 'in' ? '' : t.by ? `${t.by.name} · ` : ''}${new Date(t.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
      </div>`)}
    </div>
    ${lead.smsOptOut ? html`<p class="msg-optout">${lead.name} texted STOP. They can't be texted until they text START.</p>` : lead.phone ? html`
    <div class="msg-compose">
      <div class="cp-attachments" id="msgAttached"></div>
      <div class="msg-compose-row">
        <label class="msg-attach" title="Photo or video" aria-label="Attach a photo or video">📎<input type="file" accept="image/*,video/*" multiple id="msgFile" hidden /></label>
        <textarea id="msgInput" rows="1" placeholder="Text message">${draft}</textarea>
        <button type="button" class="btn-primary btn-small" id="msgSend">Send</button>
      </div>
      <span class="cp-composer-status" id="msgStatus"></span>
    </div>` : html`<p class="msg-optout">Add a phone number on their customer page to text them.</p>`}`;
  renderMsgAttach();
  const box = document.getElementById('msgBubbles');
  if (scrollToEnd || box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
}

function renderMsgAttach() {
  const el = document.getElementById('msgAttached');
  if (!el) return;
  el.innerHTML = msgAttach.map(m => html`<span class="cp-attachment">${m.kind === 'photo' ? html`<img src="${photoThumb(m.url, 48, 36)}" alt="" />` : html`<span class="cp-attachment-video">🎥</span>`}
    <span class="cp-attachment-name">${m.name || m.kind}</span><button type="button" data-msg-unattach="${m.id}" aria-label="Remove">✕</button></span>`).join('');
}

async function sendMessage() {
  const input = document.getElementById('msgInput');
  const status = document.getElementById('msgStatus');
  const text = input.value.trim();
  if (!text && !msgAttach.length) return input.focus();
  const btn = document.getElementById('msgSend');
  btn.disabled = true;
  status.textContent = 'Sending…';
  try {
    const res = await fetch(`${API}/leads/${msgOpenId}/send-text`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, mediaIds: msgAttach.map(m => m.id) }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not send.');
    input.value = '';
    msgAttach = [];
    await loadMessages();
    renderMsgThread(true);
  } catch (err) {
    status.innerHTML = html`<span class="send-text-status-error">${err.message}</span>`;
    btn.disabled = false;
  }
}

const msgPanel = document.getElementById('messagesPanel');
msgPanel.addEventListener('click', async (e) => {
  const open = e.target.closest('[data-msg-open]');
  if (open) return openConversation(open.dataset.msgOpen);
  if (e.target.closest('[data-msg-back]')) { msgOpenId = null; document.getElementById('msgLayout').classList.remove('thread-open'); renderMsgList(); return; }
  if (e.target.closest('[data-msg-customer]')) return openLeadProfile(msgOpenId);
  if (e.target.closest('#msgSend')) return sendMessage();
  const un = e.target.closest('[data-msg-unattach]');
  if (un) { msgAttach = msgAttach.filter(m => m.id !== un.dataset.msgUnattach); return renderMsgAttach(); }
  const scope = e.target.closest('[data-scope]');
  if (scope) {
    msgScope = scope.dataset.scope;
    document.querySelectorAll('#msgScope [data-scope]').forEach(b => b.classList.toggle('active', b === scope));
    await loadMessages();
  }
});
msgPanel.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter is a new line.
  if (e.target.id === 'msgInput' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
msgPanel.addEventListener('change', async (e) => {
  if (e.target.id !== 'msgFile' || !e.target.files.length) return;
  const status = document.getElementById('msgStatus');
  for (const file of [...e.target.files]) {
    status.textContent = `Uploading ${file.name}…`;
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API}/leads/${msgOpenId}/media`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { status.innerHTML = html`<span class="send-text-status-error">${data.error || 'Upload failed.'}</span>`; return; }
    msgAttach.push(data);
  }
  status.textContent = '';
  e.target.value = '';
  renderMsgAttach();
});
document.getElementById('msgSearch').addEventListener('input', () => msgData && renderMsgList());

// The phone app's Messages shortcut starts here.
if (currentView === 'messages') openMessagesView();
