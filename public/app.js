const chat = document.getElementById('chat');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

let currentAssistantBubble = null;

function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

function setStatus(state) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = state === 'connected' ? 'Connected' : state === 'disconnected' ? 'Disconnected — retrying…' : 'Connecting…';
}

function addBubble(role, text) {
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  el.textContent = text;
  chat.appendChild(el);
  scrollToBottom();
  return el;
}

function addCard({ className, title, body }) {
  const card = document.createElement('div');
  card.className = `card ${className}`;

  const titleEl = document.createElement('div');
  titleEl.className = 'card-title';
  titleEl.textContent = title;
  card.appendChild(titleEl);

  const pre = document.createElement('pre');
  pre.textContent = body;
  card.appendChild(pre);

  chat.appendChild(card);
  scrollToBottom();
  return card;
}

function handleEvent(event) {
  switch (event.kind) {
    case 'user_echo':
      currentAssistantBubble = null;
      addBubble('user', event.text);
      break;

    case 'text':
      if (!currentAssistantBubble) {
        currentAssistantBubble = addBubble('assistant', event.text);
      } else {
        currentAssistantBubble.textContent += event.text;
      }
      scrollToBottom();
      break;

    case 'tool_call':
      currentAssistantBubble = null;
      addCard({
        className: 'tool-call',
        title: `Tool call · ${event.name}`,
        body: JSON.stringify(event.input, null, 2),
      });
      break;

    case 'tool_result':
      currentAssistantBubble = null;
      addCard({
        className: `tool-result ${event.isError ? 'error' : ''}`.trim(),
        title: event.isError ? 'Tool error' : 'Tool result',
        body: event.content || '(empty)',
      });
      break;

    case 'done':
      currentAssistantBubble = null;
      if (event.isError) {
        addCard({
          className: 'system-error',
          title: 'Turn ended with an error',
          body: event.subtype || 'unknown error',
        });
      }
      break;

    case 'error':
      currentAssistantBubble = null;
      addCard({ className: 'system-error', title: 'Error', body: event.message });
      break;

    default:
      break;
  }
}

const RECONNECT_DELAY_MS = 2000;
let eventSource = null;

async function connect() {
  setStatus('connecting');

  let token;
  try {
    token = await window.shopify.idToken();
  } catch {
    setStatus('disconnected');
    setTimeout(connect, RECONNECT_DELAY_MS);
    return;
  }

  // EventSource can't set an Authorization header, so the fresh session
  // token travels as a query param instead.
  eventSource = new EventSource(`/events?token=${encodeURIComponent(token)}`);

  eventSource.onopen = () => setStatus('connected');
  eventSource.onerror = () => {
    setStatus('disconnected');
    eventSource.close();
    // Reconnect with a freshly-fetched token rather than letting EventSource
    // auto-retry the same URL with an expired one.
    setTimeout(connect, RECONNECT_DELAY_MS);
  };

  eventSource.onmessage = (raw) => {
    try {
      handleEvent(JSON.parse(raw.data));
    } catch {
      // ignore malformed frames (e.g. the initial ": connected" comment)
    }
  };
}

async function sendMessage(text) {
  const token = await window.shopify.idToken();
  await fetch('/api/message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ text }),
  });
}

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  sendMessage(text);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
});

setStatus('connecting');
connect();
