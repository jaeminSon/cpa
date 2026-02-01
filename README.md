# CP Assistant

Competitive programming helper for VS Code powered by OpenAI. Load a problem statement from a URL (or paste it), then ask for hints, approach checks, or a full C++17 solution.

## Features

- Sidebar webview with chat interface
- Fetches problem statements from a URL
- Manual paste fallback when sites block automated fetches
- Extracts sample inputs/outputs when possible
- Stores your API key securely in VS Code SecretStorage

## Requirements

- VS Code 1.90+ (`engines.vscode`)
- OpenAI API key

## Getting Started

1. Install the extension.
2. Open the **CP ASSISTANT** view in the Activity Bar.
3. Click **Log in (set API key)** and paste your OpenAI API key.
4. Paste a problem URL (e.g., `https://www.acmicpc.net/problem/1000`) and press Enter.
5. Ask for a hint, verify your approach, or request code.

If a site blocks automated fetches, the extension will ask you to paste the problem statement manually.

## Commands

- **CP Assistant: Open** (`cpAssistant.open`)
- **CP Assistant: Clear Conversation** (`cpAssistant.clearConversation`)
- **CP Assistant: Set OpenAI API Key** (`cpAssistant.setApiKey`)
- **CP Assistant: Clear OpenAI API Key** (`cpAssistant.clearApiKey`)

## Settings

- `cpAssistant.openaiModel` (default: `gpt-4.1-mini`)
- `cpAssistant.maxTokens` (default: `1200`)
- `cpAssistant.temperature` (default: `0.3`)

## Notes on Data & Privacy

- Your API key is stored in VS Code SecretStorage on your machine.
- Problem text is fetched from the provided URL or from your manual paste.
- Requests are sent to the OpenAI API using the model you configure.
