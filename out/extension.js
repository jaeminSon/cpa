"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const SECRET_KEY_NAME = 'cpAssistant.openaiApiKey';
function activate(context) {
    const controller = new CpAssistantController(context);
    context.subscriptions.push(vscode.commands.registerCommand('cpAssistant.open', () => controller.openPanel()), vscode.commands.registerCommand('cpAssistant.clearConversation', () => controller.clearConversation()), vscode.commands.registerCommand('cpAssistant.setApiKey', () => controller.setApiKeyFlow({ openKeysPage: true })), vscode.commands.registerCommand('cpAssistant.clearApiKey', () => controller.clearApiKey()), vscode.window.registerWebviewViewProvider('cpAssistant.sidebar', controller, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
}
function deactivate() { }
class CpAssistantController {
    context;
    panel;
    view;
    currentProblem;
    chatHistory = [];
    constructor(context) {
        this.context = context;
    }
    clearConversation() {
        this.chatHistory = [];
        this.post({ type: 'clearChat' });
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };
        this.attachWebviewHandlers(webviewView.webview);
        webviewView.webview.html = this.getWebviewHtml(webviewView.webview);
        return this.postAuthState();
    }
    async openPanel() {
        // Prefer focusing the sidebar view container when available.
        if (this.view) {
            await vscode.commands.executeCommand('workbench.view.extension.cpAssistant');
            await this.postAuthState();
            return;
        }
        if (this.panel) {
            this.panel.reveal();
            await this.postAuthState();
            return;
        }
        this.panel = vscode.window.createWebviewPanel('cpAssistant', 'CP Assistant', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            ],
        });
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
        this.attachWebviewHandlers(this.panel.webview);
        this.panel.webview.html = this.getWebviewHtml(this.panel.webview);
        await this.postAuthState();
    }
    attachWebviewHandlers(webview) {
        webview.onDidReceiveMessage(async (msg) => {
            try {
                switch (msg.type) {
                    case 'openApiKeyPageAndSetKey':
                        await this.setApiKeyFlow({ openKeysPage: true });
                        break;
                    case 'clearApiKey':
                        await this.clearApiKey();
                        break;
                    case 'fetchProblemFromUrl':
                        await this.fetchProblemFromUrl(msg.url);
                        break;
                    case 'manualPasteProblem':
                        await this.setProblemFromManualPaste({ urlRaw: msg.url, problemText: msg.problemText });
                        break;
                    case 'sendChat':
                        await this.sendChat(msg.text);
                        break;
                    default:
                        this.post({ type: 'error', message: 'Unknown message from webview.' });
                }
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.post({ type: 'error', message });
            }
        });
    }
    post(message) {
        void this.panel?.webview.postMessage(message);
        void this.view?.webview.postMessage(message);
    }
    async postAuthState() {
        const apiKey = await this.getApiKey();
        this.post({ type: 'authState', isAuthed: Boolean(apiKey) });
    }
    async setApiKeyFlow(opts) {
        if (opts.openKeysPage) {
            void vscode.env.openExternal(vscode.Uri.parse('https://platform.openai.com/api-keys'));
        }
        const apiKey = await vscode.window.showInputBox({
            title: 'OpenAI API Key',
            prompt: 'Paste your OpenAI API key (stored in VS Code SecretStorage).',
            password: true,
            ignoreFocusOut: true,
            validateInput: (v) => {
                if (!v.trim())
                    return 'API key cannot be empty.';
                if (!/^sk-/.test(v.trim()))
                    return 'Expected an OpenAI API key starting with "sk-".';
                return null;
            },
        });
        if (!apiKey)
            return;
        await this.context.secrets.store(SECRET_KEY_NAME, apiKey.trim());
        await this.postAuthState();
    }
    async clearApiKey() {
        await this.context.secrets.delete(SECRET_KEY_NAME);
        await this.postAuthState();
    }
    async getApiKey() {
        const v = await this.context.secrets.get(SECRET_KEY_NAME);
        return v?.trim() ? v.trim() : undefined;
    }
    async fetchProblemFromUrl(urlRaw) {
        const url = normalizeHttpUrl(urlRaw);
        let html = '';
        try {
            html = await fetchText(url);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Offer manual paste fallback when automated fetch is blocked.
            this.post({ type: 'pasteFallback', url, message });
            return;
        }
        const problemText = extractReadableTextFromHtml(html);
        const samples = extractSamples(problemText);
        this.setCurrentProblem({ url, problemText, samples });
    }
    async setProblemFromManualPaste(opts) {
        const url = normalizeHttpUrl(opts.urlRaw);
        const problemText = (opts.problemText || '').replace(/\r/g, '').trim();
        if (!problemText) {
            this.post({ type: 'error', message: 'Paste is empty.' });
            return;
        }
        const samples = extractSamples(problemText);
        this.setCurrentProblem({ url, problemText, samples });
    }
    setCurrentProblem(opts) {
        this.currentProblem = { url: opts.url, text: opts.problemText, samples: opts.samples };
        this.chatHistory = [];
        this.post({
            type: 'problemLoaded',
            url: opts.url,
            problemText: opts.problemText,
            extractedSamples: opts.samples,
        });
    }
    async sendChat(userText) {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            this.post({ type: 'error', message: 'Not logged in. Set your OpenAI API key first.' });
            await this.postAuthState();
            return;
        }
        const text = userText.trim();
        if (!text)
            return;
        this.post({ type: 'chatMessage', role: 'user', text });
        this.chatHistory.push({ role: 'user', content: text });
        const cfg = vscode.workspace.getConfiguration('cpAssistant');
        const model = cfg.get('openaiModel', 'gpt-4.1-mini');
        const maxTokens = cfg.get('maxTokens', 1200);
        const temperature = cfg.get('temperature', 0.3);
        const systemParts = [
            'You are a competitive programming assistant. Be concise and correct.',
            'Prefer step-by-step reasoning only when asked; otherwise provide actionable guidance.',
            'When producing code, use C++17, include headers, fast IO, and handle edge cases.',
        ];
        if (this.currentProblem) {
            systemParts.push('Problem context (may be truncated):');
            systemParts.push(this.currentProblem.text.slice(0, 25000));
            if (this.currentProblem.samples.length) {
                systemParts.push('Extracted samples:');
                for (const s of this.currentProblem.samples.slice(0, 4)) {
                    systemParts.push(`Sample Input:\n${(s.input ?? '').slice(0, 4000)}`);
                    systemParts.push(`Sample Output:\n${(s.output ?? '').slice(0, 4000)}`);
                }
            }
        }
        else {
            systemParts.push('No problem loaded yet. Ask the user for a URL or statement.');
        }
        const messages = [
            { role: 'system', content: systemParts.join('\n\n') },
        ];
        // Keep the most recent turns to stay within context.
        const recent = this.chatHistory.slice(-12);
        for (const m of recent)
            messages.push({ role: m.role, content: m.content });
        const assistantText = await openaiChatCompletion({
            apiKey,
            model,
            temperature,
            maxTokens,
            messages,
        });
        this.chatHistory.push({ role: 'assistant', content: assistantText });
        this.post({ type: 'chatMessage', role: 'assistant', text: assistantText });
    }
    getWebviewHtml(webview) {
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
        return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>CP Assistant</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
    }
}
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++)
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
}
function normalizeHttpUrl(raw) {
    const s = raw.trim();
    if (!s)
        throw new Error('URL is required.');
    if (/^https?:\/\//i.test(s))
        return s;
    return `https://${s}`;
}
async function fetchText(url) {
    const res = await fetch(url, {
        redirect: 'follow',
        headers: {
            // Some competitive programming sites (e.g. acmicpc.net) return 403 for non-browser user agents.
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
        },
    });
    const text = await safeReadTextFull(res);
    // Cloudflare bot checks: requires JS/cookies from a real browser.
    if (res.status === 403 && isCloudflareChallenge(res, text)) {
        throw new Error('Failed to fetch URL: blocked by Cloudflare bot protection (403). This requires a real browser session; automatic fetch is not supported.');
    }
    // Baekjoon (acmicpc.net) and some others may respond with an AWS WAF JS challenge (202).
    // This requires executing JavaScript in a real browser; we can't solve it in an extension fetch.
    if (res.status === 202 &&
        (res.headers.get('x-amzn-waf-action') === 'challenge' || looksLikeAwsWafChallenge(text) || !text.trim())) {
        throw new Error('Failed to fetch URL: blocked by AWS WAF challenge. Open the URL in a browser and copy/paste the statement, or use another source URL.');
    }
    if (!res.ok)
        throw new Error(`Failed to fetch URL: ${res.status} ${res.statusText}`);
    return text;
}
function isCloudflareChallenge(res, html) {
    const server = (res.headers.get('server') || '').toLowerCase();
    if (server.includes('cloudflare'))
        return true;
    if ((res.headers.get('cf-mitigated') || '').toLowerCase() === 'challenge')
        return true;
    // Best-effort body indicators.
    return /cf-ray|cf-chl|cloudflare/i.test(html);
}
function looksLikeAwsWafChallenge(html) {
    return /awsWafCookieDomainList|gokuProps/i.test(html);
}
function extractReadableTextFromHtml(html) {
    // Lightweight extraction (no heavy dependencies). Best-effort across sites.
    let s = html;
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
    s = s.replace(/<br\s*\/?\s*>/gi, '\n');
    s = s.replace(/<\/p\s*>/gi, '\n\n');
    s = s.replace(/<\/div\s*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, ' ');
    s = decodeHtmlEntities(s);
    s = s.replace(/\r/g, '');
    s = s.replace(/[ \t]+/g, ' ');
    s = s.replace(/\n\s+\n/g, '\n\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
}
function decodeHtmlEntities(s) {
    const map = {
        '&nbsp;': ' ',
        '&lt;': '<',
        '&gt;': '>',
        '&amp;': '&',
        '&quot;': '"',
        '&#39;': "'",
    };
    return s.replace(/&(nbsp|lt|gt|amp|quot);|&#39;/g, (m) => map[m] ?? m);
}
function extractSamples(text) {
    // Best-effort extraction by common headings.
    const lines = text.split('\n').map((l) => l.trimEnd());
    const joined = lines.join('\n');
    const candidates = [];
    const re = /(Sample\s+Input|Input\s+Example|Example\s+Input)\s*:\s*([\s\S]{0,4000}?)(Sample\s+Output|Output\s+Example|Example\s+Output)\s*:\s*([\s\S]{0,4000}?)(\n\s*\n|$)/gi;
    let m;
    while ((m = re.exec(joined)) !== null) {
        const input = m[2].trim();
        const output = m[4].trim();
        candidates.push({ input: input || undefined, output: output || undefined });
        if (candidates.length >= 4)
            break;
    }
    return candidates;
}
async function openaiChatCompletion(opts) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
            model: opts.model,
            messages: opts.messages,
            temperature: opts.temperature,
            max_tokens: opts.maxTokens,
        }),
    });
    if (!res.ok) {
        const t = await safeReadText(res);
        throw new Error(`OpenAI request failed: ${res.status} ${res.statusText}${t ? `\n${t}` : ''}`);
    }
    const json = await res.json();
    const content = getFirstChatCompletionContent(json);
    if (!content.trim())
        throw new Error('OpenAI response missing message content.');
    return content.trim();
}
function getFirstChatCompletionContent(json) {
    if (!isRecord(json))
        return '';
    const choices = json.choices;
    if (!Array.isArray(choices) || choices.length < 1)
        return '';
    const first = choices[0];
    if (!isRecord(first))
        return '';
    const message = first.message;
    if (!isRecord(message))
        return '';
    const content = message.content;
    return typeof content === 'string' ? content : '';
}
function isRecord(v) {
    return typeof v === 'object' && v !== null;
}
async function safeReadText(res) {
    try {
        return (await res.text()).slice(0, 2000);
    }
    catch {
        return '';
    }
}
async function safeReadTextFull(res) {
    try {
        return await res.text();
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=extension.js.map