// Decode SSE independently of network chunk boundaries, including split UTF-8.
async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '', lines = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 1048576) throw new Error('Provider event too large');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
      if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
      if (!line && lines.length) {
        const data = lines.join('\n'); lines = [];
        if (data !== '[DONE]') yield JSON.parse(data);
      }
    }
  }
  // A valid completed event must arrive before the connection ends.
}

// Expose only the leading reply string, never incomplete JSON or draft fields.
function replyPrefix(text) {
  const match = /^\s*\{\s*"reply"\s*:\s*"/.exec(text);
  if (!match) return '';
  const start = match[0].length;
  let index = start;
  while (index < text.length) {
    if (text[index] === '"') break;
    if (text[index] === '\\') {
      const length = text[index + 1] === 'u' ? 6 : 2;
      if (index + length > text.length) break;
      index += length;
    } else index++;
  }
  try { return JSON.parse('"' + text.slice(start, index) + '"').slice(0, 4000); }
  catch { return ''; }
}
async function consumeResponseStream(body, onReply) {
  let text = '', emitted = '';
  for await (const event of readEvents(body)) {
    if (event.type === 'response.output_text.delta') {
      text += event.delta || '';
      if (text.length > 262144) throw new Error('Provider output too large');
      const reply = replyPrefix(text);
      if (reply.startsWith(emitted) && reply.length > emitted.length) {
        onReply(reply.slice(emitted.length)); emitted = reply;
      }
    }
    if (event.type === 'response.completed') {
      if (event.response?.status !== 'completed') throw new Error('Incomplete provider response');
      return event.response;
    }
    if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) throw new Error('Provider stream failed');
  }
  throw new Error('Provider stream ended before completion');
}
module.exports = { readEvents, replyPrefix, consumeResponseStream };
