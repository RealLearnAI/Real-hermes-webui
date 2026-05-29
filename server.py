#!/usr/bin/env python3
"""Hermes WebUI - Backend using hermes API server for reliable agent execution."""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

try:
    from aiohttp import web
except ImportError:
    os.system(f'"{sys.executable}" -m pip install aiohttp')
    from aiohttp import web

# Hermes API server endpoint
HERMES_API = "http://127.0.0.1:8642"

WEBUI_PORT = int(os.environ.get("WEBUI_PORT", 7860))
DATA_DIR = Path.home() / "hermes-webui"
SESSIONS_FILE = DATA_DIR / "sessions.json"


def load_sessions():
    if SESSIONS_FILE.exists():
        try: return json.loads(SESSIONS_FILE.read_text(encoding="utf-8"))
        except: pass
    return []

def save_sessions(sessions):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SESSIONS_FILE.write_text(json.dumps(sessions, ensure_ascii=False, indent=2), encoding="utf-8")


async def chat_endpoint(request):
    """Chat using hermes API server - avoids Windows CLI encoding issues."""
    t0 = time.time()
    try:
        raw_body = await request.read()
        body = json.loads(raw_body.decode("utf-8"))
    except Exception as e:
        return web.json_response({"error": f"Invalid JSON: {str(e)}"}, status=400)

    messages = body.get("messages", [])
    if not messages:
        return web.json_response({"error": "No messages"}, status=400)

    user_msg = messages[-1].get("content", "")
    
    # Stream response via SSE
    sse = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
    
    try:
        await sse.prepare(request)
        t1 = time.time()
        print(f"[WebUI] SSE prepared in {t1-t0:.2f}s")
        
        # Call hermes API server directly with proper UTF-8 encoding
        import aiohttp
        
        api_payload = {
            "model": "hermes-agent",
            "messages": messages,
            "stream": True,
        }
        
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{HERMES_API}/v1/chat/completions",
                json=api_payload,
                timeout=aiohttp.ClientTimeout(total=300),
            ) as api_resp:
                t2 = time.time()
                print(f"[WebUI] API connection established in {t2-t1:.2f}s")
                
                if api_resp.status != 200:
                    err_text = await api_resp.text()
                    raise Exception(f"API error {api_resp.status}: {err_text}")
                
                # Stream the API response to our SSE client
                full_response = ""
                first_chunk_t = None
                while True:
                    chunk = await api_resp.content.readline()
                    if not chunk:
                        break
                    
                    text = chunk.decode("utf-8", errors="replace").strip()
                    if not text or not text.startswith("data:"):
                        continue
                    
                    data_str = text[5:].strip()
                    if data_str == "[DONE]":
                        break
                    
                    try:
                        data = json.loads(data_str)
                        content = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
                        if content:
                            if first_chunk_t is None:
                                first_chunk_t = time.time()
                                print(f"[WebUI] First chunk after {first_chunk_t-t2:.2f}s")
                            full_response += content
                            await sse.write(
                                f"data: {json.dumps({'type': 'chunk', 'content': content}, ensure_ascii=False)}\n\n".encode("utf-8")
                            )
                    except json.JSONDecodeError:
                        pass
                
                t3 = time.time()
                print(f"[WebUI] Total API streaming: {t3-t2:.2f}s, Full response: {len(full_response)} chars")
                
                # Send completion event
                await sse.write(
                    f"data: {json.dumps({'type': 'done', 'response': full_response})}\n\n".encode("utf-8")
                )
        
        t4 = time.time()
        print(f"[WebUI] Total request time: {t4-t0:.2f}s")
        return sse
        
    except Exception as e:
        print(f"[WebUI] Error: {e}")
        if sse.prepared:
            await sse.write(
                f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n".encode("utf-8")
            )
        return web.json_response({"error": str(e)}, status=500)


async def sessions_list(request):
    return web.json_response(load_sessions())

async def sessions_create(request):
    try: 
        raw = await request.read()
        body = json.loads(raw.decode("utf-8"))
    except: 
        body = {}
    sessions = load_sessions()
    session = {
        "id": f"web_{len(sessions) + 1}",
        "title": body.get("title", "新对话"),
        "messages": [],
        "hermes_session_id": None,
    }
    sessions.append(session)
    save_sessions(sessions)
    return web.json_response(session)

async def sessions_delete(request):
    session_id = request.match_info["session_id"]
    sessions = [s for s in load_sessions() if s["id"] != session_id]
    save_sessions(sessions)
    return web.json_response({"ok": True})


async def health_check(request):
    import aiohttp
    api_status = "disconnected"
    try:
        async with aiohttp.ClientSession() as sess:
            async with sess.get(f"{HERMES_API}/health", timeout=aiohttp.ClientTimeout(total=5)) as r:
                if r.status == 200:
                    api_status = "connected"
    except:
        pass
    
    return web.json_response({
        "status": "ok",
        "webui": "running",
        "hermes_api": api_status,
    })


def create_app():
    app = web.Application()

    # API routes - registered BEFORE catch-all
    app.router.add_get("/api/health", health_check)
    app.router.add_post("/api/chat", chat_endpoint)
    app.router.add_get("/api/sessions", sessions_list)
    app.router.add_post("/api/sessions", sessions_create)
    app.router.add_delete("/api/sessions/{session_id}", sessions_delete)

    # Serve frontend
    static_dir = DATA_DIR / "static"
    index_path = static_dir / "index.html"
    
    if index_path.exists():
        async def serve_index(request):
            return web.FileResponse(index_path)
        
        app.router.add_get("/", serve_index)
        app.router.add_static("/assets/", str(static_dir))
        app.router.add_route("*", "/{path:.+}", serve_index)
    else:
        async def serve_fallback(request):
            return web.Response(text="Hermes WebUI - Files not found", status=503)
        app.router.add_get("/", serve_fallback)

    return app


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    app = create_app()
    print(f"\n{'='*50}")
    print(f"  Hermes WebUI Server")
    print(f"  http://localhost:{WEBUI_PORT}")
    print(f"  Hermes API: {HERMES_API}")
    print(f"{'='*50}\n")
    web.run_app(app, host="0.0.0.0", port=WEBUI_PORT)
