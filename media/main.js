(function () {
  const vscode = acquireVsCodeApi();

  const state = {
    isAuthed: false,
    url: '',
    draft: '',
    pasteFallback: null,
  };

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = String(v);
      else if (k === 'text') node.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, String(v));
    }
    for (const c of children) node.appendChild(c);
    return node;
  }

  function render() {
    const root = document.getElementById('root');
    root.innerHTML = '';

    if (!state.isAuthed) {
      const card = el('div', { class: 'card loginInner' }, [
        el('h1', { class: 'title', text: 'Competitive Programming Assistant' }),
        el('p', { class: 'sub', text: 'To use OpenAI from this extension, paste an API key. It is stored in VS Code SecretStorage on this machine.' }),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'btn primary',
            text: 'Log in (set API key)',
            onclick: () => vscode.postMessage({ type: 'openApiKeyPageAndSetKey' })
          }),
        ]),
      ]);

      root.appendChild(el('div', { class: 'login shell' }, [card]));
      return;
    }

    const urlInput = el('input', {
      class: 'urlInput',
      placeholder: 'Problem URL (e.g. https://www.acmicpc.net/problem/...)',
      value: state.url,
      oninput: (e) => (state.url = e.target.value),
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          maybeFetchProblemFromUrl('enter');
        }
      },
      onblur: () => maybeFetchProblemFromUrl('blur'),
    });

    const top = el('div', { class: 'card topbar' }, [
      urlInput,
    ]);

    const pasteCard =
      state.pasteFallback &&
      el('div', { class: 'card composer' }, [
        el('div', { class: 'sub', text: `Auto-fetch blocked. Paste the problem statement here (no edits).\n${state.pasteFallback.message}` }),
        el('textarea', {
          class: 'textArea',
          placeholder: 'Paste problem statement (and examples if present)…',
          value: state.pasteFallback.problemText,
          oninput: (e) => (state.pasteFallback.problemText = e.target.value),
        }),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'btn primary',
            text: 'Use pasted text',
            onclick: () => {
              vscode.postMessage({
                type: 'manualPasteProblem',
                url: state.url,
                problemText: state.pasteFallback.problemText,
              });
              state.pasteFallback = null;
              render();
            },
          }),
        ]),
      ]);

    const chat = el('div', { class: 'chat', id: 'chat' });

    const textArea = el('textarea', {
      class: 'textArea',
      placeholder: 'Ask for a hint, paste your approach, or request code…',
      value: state.draft,
      oninput: (e) => (state.draft = e.target.value),
    });

    const sendBtn = el('button', {
      class: 'btn primary',
      text: 'Send',
      onclick: () => sendDraft(),
    });

    const preset = (label, text) =>
      el('button', {
        class: 'btn',
        text: label,
        onclick: () => {
          state.draft = text;
          textArea.value = state.draft;
          textArea.focus();
        },
      });

    const hintBtn = preset('hint', 'Give me a hint.');
    const verifyBtn = preset('verify', 'Select one: [correct, incorrect, need more elaboration]. Verify my approach below:\n');
    const codeBtn = preset('code', 'Write a c++ code solution based on the discussion.');

    const bottom = el('div', { class: 'card composer' }, [
      textArea,
      el('div', { class: 'row' }, [
        el('div', { class: 'row grow hintRow' }, [hintBtn, verifyBtn, codeBtn]),
        sendBtn,
      ]),
    ]);

    root.appendChild(el('div', { class: 'shell' }, [top, ...(pasteCard ? [pasteCard] : []), chat, bottom]));
  }

  function appendMessage(role, text) {
    const chat = document.getElementById('chat');
    if (!chat) return;
    const node = el('div', { class: `msg ${role}` });
    node.textContent = text;
    chat.appendChild(node);
    chat.scrollTop = chat.scrollHeight;
  }

  function maybeFetchProblemFromUrl(reason) {
    const url = (state.url || '').trim();
    if (!url) return;
    if (state.lastFetchedUrl === url) return;
    state.lastFetchedUrl = url;
    vscode.postMessage({ type: 'fetchProblemFromUrl', url });
  }

  function sendDraft() {
    const t = (state.draft || '').trim();
    if (!t) return;
    vscode.postMessage({ type: 'sendChat', text: state.draft });
    state.draft = '';
    const ta = document.querySelector('textarea.textArea');
    if (ta) ta.value = '';
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'authState':
        state.isAuthed = Boolean(msg.isAuthed);
        render();
        break;
      case 'chatMessage':
        appendMessage(msg.role, msg.text);
        break;
      case 'problemLoaded':
        state.pasteFallback = null;
        appendMessage('system', `Loaded problem from: ${msg.url}`);
        if (msg.problemText) appendMessage('system', msg.problemText);
        if (Array.isArray(msg.extractedSamples) && msg.extractedSamples.length) {
          for (let i = 0; i < msg.extractedSamples.length; i++) {
            const s = msg.extractedSamples[i] || {};
            if (s.input != null) appendMessage('system', `Sample Input ${i + 1}:\n${s.input}`);
            if (s.output != null) appendMessage('system', `Sample Output ${i + 1}:\n${s.output}`);
          }
        }
        break;
      case 'pasteFallback':
        state.url = msg.url || state.url;
        state.pasteFallback = { url: msg.url, message: msg.message || '', problemText: '' };
        render();
        break;
      case 'error':
        appendMessage('system', `Error: ${msg.message}`);
        break;
      case 'clearChat': {
        const chat = document.getElementById('chat');
        if (chat) chat.innerHTML = '';
        state.pasteFallback = null;
        render();
        break;
      }
      default:
        break;
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      sendDraft();
    }
  });

  render();
})();
