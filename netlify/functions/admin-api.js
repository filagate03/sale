
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRYPTO_SECRET = process.env.CRYPTO_SECRET || 'change-me-32bytes-change-me-32bytes';

function sbAdmin(){ return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }); }

function enc(plain){
  if (!plain) return null;
  const key = crypto.createHash('sha256').update(CRYPTO_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

async function getUserFromToken(sb, token){
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error) return null;
  return data?.user || null;
}

export async function handler(event){
  const method = event.httpMethod || 'GET';
  const authHeader = event.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const sb = sbAdmin();
  const user = await getUserFromToken(sb, token);
  if (!user) return { statusCode: 401, body: 'unauthorized' };

  try{
    if (method === 'POST'){
      const body = event.body ? JSON.parse(event.body) : {};
      const action = body.action;

      if (action === 'upsert_agent'){
        const a = body.agent || {};
        if (!a.id) return { statusCode:400, body:'missing id' };
        const bot_token_enc = a.bot_token ? enc(a.bot_token) : undefined;
        const openai_key_enc = a.openai_key ? enc(a.openai_key) : undefined;

        const { data: ex } = await sb.from('agents').select('id, owner_id').eq('id', a.id).maybeSingle();
        if (ex){
          if (ex.owner_id !== user.id) return { statusCode:403, body:'forbidden' };
          const patch = {
            name: a.name || a.id,
            model: a.model || 'gpt-5-nano',
            system_prompt: a.system_prompt || 'Ты ИИ-продавец. Пиши обычным текстом, без JSON.',
            manager_chat_id: a.manager_chat_id || null,
            intent_keywords: a.intent_keywords || 'записаться, звонок, консультация, встреча, заявка',
            timezone: a.timezone || 'Europe/Amsterdam',
            sheets_webhook_url: a.sheets_webhook_url || null,
            calendar_webhook_url: a.calendar_webhook_url || null,
            crm_mode: a.crm_mode || 'off',
            crm_webhook_url: a.crm_webhook_url || null
          };
          if (bot_token_enc !== undefined) patch.bot_token_enc = bot_token_enc;
          if (openai_key_enc !== undefined) patch.openai_key_enc = openai_key_enc;
          const { error } = await sb.from('agents').update(patch).eq('id', a.id);
          if (error) return { statusCode:500, body: error.message };
          return { statusCode:200, body: JSON.stringify({ ok:true, updated:true }) };
        }else{
          const ins = {
            id: a.id, owner_id: user.id, name: a.name || a.id,
            bot_token_enc: bot_token_enc || null,
            openai_key_enc: openai_key_enc || null,
            model: a.model || 'gpt-5-nano',
            system_prompt: a.system_prompt || 'Ты ИИ-продавец. Пиши обычным текстом, без JSON.',
            manager_chat_id: a.manager_chat_id || null,
            intent_keywords: a.intent_keywords || 'записаться, звонок, консультация, встреча, заявка',
            timezone: a.timezone || 'Europe/Amsterdam',
            sheets_webhook_url: a.sheets_webhook_url || null,
            calendar_webhook_url: a.calendar_webhook_url || null,
            crm_mode: a.crm_mode || 'off',
            crm_webhook_url: a.crm_webhook_url || null
          };
          const { error } = await sb.from('agents').insert(ins);
          if (error) return { statusCode:500, body: error.message };
          return { statusCode:200, body: JSON.stringify({ ok:true, created:true }) };
        }
      }

      if (action === 'list_agents'){
        const { data, error } = await sb.from('agents')
          .select('id,name,model,manager_chat_id,timezone,intent_keywords,sheets_webhook_url,calendar_webhook_url,crm_mode,crm_webhook_url,created_at')
          .eq('owner_id', user.id).order('created_at',{ascending:false});
        if (error) return { statusCode:500, body: error.message };
        return { statusCode:200, body: JSON.stringify({ agents: data||[] }) };
      }

      if (action === 'set_webhook'){
        const { agent_id, public_base } = body;
        if (!agent_id || !public_base) return { statusCode:400, body:'missing params' };
        const { data: a, error } = await sb.from('agents').select('bot_token_enc').eq('id', agent_id).single();
        if (error || !a) return { statusCode:404, body:'agent not found' };
        const bot_token = (()=>{
          const key = import('crypto');
          return null;
        })();
        // decrypt inline to avoid dynamic import dance
        const crypto2 = await import('crypto');
        const key = crypto2.createHash('sha256').update(process.env.CRYPTO_SECRET || 'change-me-32bytes-change-me-32bytes').digest();
        const buf = Buffer.from(a.bot_token_enc||'', 'base64');
        if (!buf.length) return { statusCode:400, body:'agent has no bot token' };
        const iv = buf.subarray(0,12), tag = buf.subarray(12,28), enc = buf.subarray(28);
        const decipher = crypto2.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const botToken = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');

        const hookUrl = `${public_base.replace(/\/$/, '')}/.netlify/functions/tg-webhook?agent=${encodeURIComponent(agent_id)}`;
        const resp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(hookUrl)}`);
        const txt = await resp.text();
        return { statusCode: resp.ok ? 200 : 500, body: txt };
      }

      return { statusCode:400, body:'unknown action' };
    }

    return { statusCode:405, body:'method not allowed' };
  }catch(e){
    console.error('admin-api fatal', e);
    return { statusCode:500, body:'server error' };
  }
}
