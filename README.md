# Hermes WebUI

Web interface for Hermes Agent, featuring real-time AI conversations, session management, GPU monitoring, and more.

## Quick Start

### Install

```bash
git clone https://github.com/RealLearnAI/hermes-webui.git
cd hermes-webui
```

### Run

```bash
node server.mjs
```

Then open `http://localhost:3000` in your browser.

## Features

### Conversation
- Real-time streaming chat (SSE)
- Multi-session management and switching
- Agent identity switching (multi-role support)
- Image message sending
- Context window management
- Session history persistence
- Hermes Gateway API proxy support

### Steer Mode
- Send button adapts to AI status (send/steer toggle)
- Smart conversation guidance based on AI working state

### Performance Monitoring
- Real-time GPU usage monitoring
- Token generation speed display (tokens/sec)
- Cumulative token count tracking
- Request status indicator (animated conic-gradient)

### Logging & Debugging
- Real-time log panel
- Tool call visualization
- API request/response tracing

## Files

| File | Description |
|------|-------------|
| `index.html` | Frontend interface (all UI and interaction logic) |
| `server.mjs` | Node.js server (zero dependencies, SSE streaming) |
| `server.py` | Python server (alternative) |
| `sessions.json` | Session data persistence |

## Configuration

The server automatically reads `API_SERVER_KEY` from `~/.hermes/.env` to connect to Hermes Gateway.

## Tech Stack

- **Frontend**: Pure HTML/CSS/JavaScript, zero framework dependencies
- **Backend**: Node.js (ES Module), no third-party dependencies
- **Communication**: Server-Sent Events (SSE) for real-time streaming

## License

MIT
