import {escapeHTML} from './visual-renderer.js';
const userMessage = message => (message.role || message.authorType) === 'user';
const author = message => message.agentId || message.authorId;
export function resultsForMessage(message, messages, visuals) {
  const user = userMessage(message), parent = messages.find(item => item.id === message.replyTo);
  return visuals.filter(visual => {
    if (!user && visual.agentId !== author(message)) return false;
    if (visual.messageId === message.id) {
      return !user || !messages.some(reply => !userMessage(reply) && reply.replyTo === message.id && author(reply) === visual.agentId);
    }
    return !user && parent && userMessage(parent) && visual.messageId === parent.id;
  });
}
export function highlightedMessage(content, agents) {
  const names = [...new Set(['all', ...agents.flatMap(agent => [agent.name, agent.id])])].filter(Boolean).sort((a,b)=>b.length-a.length);
  const pattern = names.map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const mentions = new RegExp('(^|[^A-Za-z0-9_@.+-])(@(?:'+pattern+'))(?=$|[^A-Za-z0-9_-])','giu');
  let cursor=0,html='',match;
  while((match=mentions.exec(content))){html+=escapeHTML(content.slice(cursor,match.index))+escapeHTML(match[1])+'<span class="mention">'+escapeHTML(match[2])+'</span>';cursor=mentions.lastIndex;}
  return html+escapeHTML(content.slice(cursor));
}
