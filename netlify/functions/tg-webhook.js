
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GLOBAL_OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const CRYPTO_SECRET = process.env.CRYPTO_SECRET || 'change-me-32bytes-change-me-32bytes';

function sb(){ return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }

function dec(b64){
  if (!b64) return null;
  const key = crypto.createHash('sha256').update(CRYPTO_SECRET).digest();
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0,12);
  const tag = buf.subarray(12,28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  return out.toString('utf8');
}

function addMinISO(iso, min){ const d=new Date(iso); d.setMinutes(d.getMinutes()+ (min||30)); return d.toISOString(); }

async function tgSend(token, chatId, text, opts={}){
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, text, parse_mode:'HTML', disable_web_page_preview:true, ...opts })
  });
  if (!r.ok) console.error('tg send fail', await r.text());
}

function detectIntent(text, csv){
  const arr = (csv || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const low = (text || '').toLowerCase();
  return arr.some(k => low.includes(k));
}

async function openaiChat(model, systemPrompt, userText, apiKey, history=[], temperature=1){
  const messages = [];
  if (systemPrompt) messages.push({ role:'system', content: systemPrompt });
  for (const m of history) messages.push(m);
  messages.push({ role:'user', content: userText });
  const payload = { model, messages };
  if (temperature !== 1) payload.temperature = temperature;

  const call = async () => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{ 'Content-Type':'application/json','Authorization':'Bearer '+apiKey },
      body: JSON.stringify(payload)
    });
    const txt = await res.text();
    if (!res.ok){
      let j=null; try{ j=JSON.parse(txt);}catch{}
      if (j?.error?.code==='unsupported_value' && j?.error?.param==='temperature'){
        const r2 = await fetch('https://api.openai.com/v1/chat/completions', {
          method:'POST', headers:{ 'Content-Type':'application/json','Authorization':'Bearer '+apiKey },
          body: JSON.stringify({ model: payload.model, messages: payload.messages })
        });
        const j2 = await r2.json();
        return j2.choices?.[0]?.message?.content || '';
      }
      throw new Error('OpenAI '+res.status+': '+(j?.error?.message||txt));
    }
    const j = JSON.parse(txt);
    return j.choices?.[0]?.message?.content || '';
  };
  return call();
}

export async function handler(event){
  const s = sb();
  try{
    const agentId = (event.queryStringParameters?.agent||'').trim();
    if (!agentId) return { statusCode:400, body:'missing agent' };
    const upd = event.body ? JSON.parse(event.body) : {};
    const msg = upd.message;
    if (!msg || !msg.chat) return { statusCode:200, body:'no message' };
    const update_id = upd.update_id;
    const chatId = String(msg.chat.id);
    const text = msg.text || '';
    const username = msg.from?.username ? '@'+msg.from.username : (msg.from?.first_name||'user');

    const { data: agent } = await s.from('agents').select('*').eq('id', agentId).single();
    if (!agent) return { statusCode:400, body:'agent not found' };
    const botToken = dec(agent.bot_token_enc||'');
    const openaiKey = dec(agent.openai_key_enc||'') || GLOBAL_OPENAI_KEY;
    if (!botToken) return { statusCode:400, body:'agent has no bot token' };
    if (!openaiKey) return { statusCode:400, body:'no openai key' };

    const ins = await s.from('processed_updates').insert({ update_id, agent_id: agentId }).select().single();
    if (!ins?.data && ins?.error?.code === '23505') return { statusCode:200, body:'dup' };

    await s.from('tg_users').upsert({ chat_id:chatId, agent_id:agentId, username }).select().maybeSingle();
    let { data: st } = await s.from('states').select('*').eq('chat_id', chatId).eq('agent_id', agentId).maybeSingle();
    if (!st){ const r = await s.from('states').insert({ chat_id:chatId, agent_id:agentId, stage:'idle' }).select().single(); st = r.data; }

    if (text === '/start'){ await tgSend(botToken, chatId, 'Привет. Помогу согласовать вводную и записать на звонок. Чем помочь?'); return { statusCode:200, body:'ok' }; }
    if (text === '/id'){ await tgSend(botToken, chatId, 'chat_id: '+chatId); return { statusCode:200, body:'ok' }; }

    if (st.stage === 'await_datetime'){
      let iso=null; const low=(text||'').trim().toLowerCase();
      if (low==='сейчас') iso = new Date().toISOString();
      if (!iso){ const d=new Date(text.replace(' ','T')); if(!isNaN(d.getTime())) iso=d.toISOString(); }
      if (!iso){ await tgSend(botToken, chatId, 'Формат даты: YYYY-MM-DD HH:MM'); return { statusCode:200, body:'ok' }; }
      const endIso = addMinISO(iso, 30);
      await s.from('states').update({ stage:'await_contact', start_iso:iso, end_iso:endIso, updated_at:new Date().toISOString() }).eq('chat_id', chatId).eq('agent_id', agentId);
      await tgSend(botToken, chatId, 'Принял. Оставь контакт: телефон или @username'); return { statusCode:200, body:'ok' };
    }

    if (st.stage === 'await_contact'){
      const contact = text.trim();
      await s.from('states').update({ stage:'idle', contact, updated_at:new Date().toISOString() }).eq('chat_id', chatId).eq('agent_id', agentId);
      await s.from('leads').insert({ chat_id:chatId, agent_id:agentId, username, contact, start_iso: st.start_iso, end_iso: st.end_iso, notes:'' });
      if (agent.manager_chat_id){
        const note = ['Новая заявка ✅','Агент: '+(agent.name||agent.id),'Когда: '+ new Date(st.start_iso).toLocaleString(agent.timezone || 'Europe/Amsterdam'),'Контакт: '+contact,'Чат: '+chatId].join('\n');
        await tgSend(botToken, agent.manager_chat_id, note);
      }
      await tgSend(botToken, chatId, 'Подтверждаю встречу. Приглашение зафиксировал. Если нужно перенести напиши Перенос.');
      return { statusCode:200, body:'ok' };
    }

    if (detectIntent(text, agent.intent_keywords)){
      await s.from('states').update({ stage:'await_datetime', updated_at:new Date().toISOString() }).eq('chat_id', chatId).eq('agent_id', agentId);
      await tgSend(botToken, chatId, 'Окей. Напиши дату и время YYYY-MM-DD HH:MM. Можно "сейчас".');
      return { statusCode:200, body:'ok' };
    }

    const answer = await openaiChat(agent.model || 'gpt-5-nano', agent.system_prompt, text, openaiKey, [], 1);
    await tgSend(botToken, chatId, answer);
    return { statusCode:200, body:'ok' };
  }catch(e){
    console.error('tg-webhook fatal', e);
    return { statusCode:200, body:'ok' };
  }
}
