"""
知识库问答系统 - FastAPI 后端

设计要点：
1. 完全复用 src/main.py 中已有的 RAG Agent（向量库加载、检索工具、会话记忆），不重写 RAG 核心。
2. src/main.py 使用相对路径（data/、CHROMA_DIR/、chat_history.json），因此导入前统一把工作目录切到 src。
3. 以「文件路径导入」的方式加载 src/main.py，避免与本文件 backend/main.py 同名冲突。
4. /chat 采用 SSE（Server-Sent Events）逐字推送，前端呈现打字机效果。
5. 多会话管理：会话与消息落盘到 backend/data/sessions.json，接口提供列表 / 详情 / 删除 / 清空。
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# 路径准备
# ---------------------------------------------------------------------------
BACKEND_DIR = Path(__file__).resolve().parent          # src/backend
SRC_DIR = BACKEND_DIR.parent                            # src
PROJECT_DIR = SRC_DIR.parent                            # 项目根目录
FRONTEND_DIR = SRC_DIR / "frontend"                     # src/frontend
AGENT_FILE = SRC_DIR / "main.py"                        # src/main.py（你的 RAG Agent）
SESSIONS_FILE = BACKEND_DIR / "data" / "sessions.json"  # src/backend/data/sessions.json

# 先加载环境变量（main.py 里的 load_dotenv 依赖 cwd，这里提前显式加载，确保 API_KEY 一定可用）
load_dotenv(SRC_DIR / ".env")
load_dotenv(PROJECT_DIR / ".env")  # 兼容把 .env 放在项目根的情况

# main.py 内部所有路径都是相对路径，统一在 src 目录下运行
os.chdir(SRC_DIR)
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))


# ---------------------------------------------------------------------------
# 导入已有的 RAG Agent（只读复用，不修改 src/main.py）
# ---------------------------------------------------------------------------
def _load_rag_agent():
    if not AGENT_FILE.exists():
        raise RuntimeError(f"未找到 RAG Agent 文件：{AGENT_FILE}")
    spec = importlib.util.spec_from_file_location("rag_agent_main", AGENT_FILE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 RAG Agent 文件：{AGENT_FILE}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["rag_agent_main"] = module
    # 注意：这里以 "rag_agent_main" 为模块名执行，__name__ != "__main__"，
    # 因此 main.py 底部的命令行 while 循环不会被执行，只会完成向量库加载与 Agent 构建。
    spec.loader.exec_module(module)
    return module


print("[backend] 正在加载 RAG Agent 与向量库 ...")
rag = _load_rag_agent()
agent = rag.agent
print("[backend] RAG Agent 加载完成")


# ---------------------------------------------------------------------------
# 多会话存储
# ---------------------------------------------------------------------------
_store_lock = threading.Lock()   # 保护 sessions.json 的读写
_run_lock = threading.Lock()     # 串行化模型调用，避免多会话同时生成时相互干扰


def _empty_store() -> Dict[str, Any]:
    return {"sessions": {}}


def _load_store() -> Dict[str, Any]:
    if SESSIONS_FILE.exists():
        try:
            data = json.loads(SESSIONS_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("sessions"), dict):
                return data
        except Exception as exc:  # noqa: BLE001
            print(f"[backend] 会话文件损坏，已重建：{exc}")
    return _empty_store()


def _save_store(store: Dict[str, Any]) -> None:
    SESSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SESSIONS_FILE.write_text(
        json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _make_title(question: str) -> str:
    """用首个提问生成会话标题（DeepSeek 风格的历史条目）。"""
    text = " ".join((question or "").split())
    if not text:
        return "新对话"
    return text if len(text) <= 22 else text[:22] + "…"


def _new_session(title: str = "新对话") -> Dict[str, Any]:
    now = time.time()
    return {
        "id": uuid.uuid4().hex[:12],
        "title": title,
        "created_at": now,
        "updated_at": now,
        "messages": [],
    }


def _session_meta(session: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": session["id"],
        "title": session.get("title") or "新对话",
        "created_at": session.get("created_at", 0),
        "updated_at": session.get("updated_at", 0),
        "message_count": len(session.get("messages", [])),
    }


def _to_lc_messages(messages: List[Dict[str, Any]]) -> List[Any]:
    """把持久化的 [{'role','content'}] 还原成 LangChain 消息，供 Agent 使用。"""
    result: List[Any] = []
    for item in messages:
        content = item.get("content") or ""
        if not content:
            continue
        if item.get("role") == "user":
            result.append(HumanMessage(content=content))
        else:
            result.append(AIMessage(content=content))
    return result


def _list_sessions() -> List[Dict[str, Any]]:
    with _store_lock:
        store = _load_store()
    metas = [
        _session_meta(s)
        for s in store["sessions"].values()
        if len(s.get("messages", [])) > 0
    ]
    metas.sort(key=lambda m: m["updated_at"], reverse=True)
    return metas


# ---------------------------------------------------------------------------
# FastAPI 应用
# ---------------------------------------------------------------------------
app = FastAPI(title="知识库问答系统", description="基于 LangChain RAG Agent 的流式问答接口")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    question: str = Field(..., description="用户提问内容")
    session_id: Optional[str] = Field(default=None, description="会话 ID，为空则自动新建会话")


def _extract_text(chunk: Any) -> str:
    """从模型流式分片里取出文本内容，兼容 str 与 list 两种 content 结构。"""
    content = getattr(chunk, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
        return "".join(parts)
    return ""


def _run_agent(session_id: Optional[str], question: str, emit: Callable[[Dict[str, Any]], None]) -> None:
    """在子线程里跑同步 Agent，并把逐字结果通过 emit 抛回主线程（事件循环）。"""
    try:
        # 1) 取出（或新建）会话，写入用户提问
        with _store_lock:
            store = _load_store()
            session = store["sessions"].get(session_id) if session_id else None
            if session is None:
                session = _new_session(_make_title(question))
                store["sessions"][session["id"]] = session
            if not session["messages"]:
                session["title"] = _make_title(question)
            session["messages"].append({"role": "user", "content": question, "ts": time.time()})
            session["updated_at"] = time.time()
            _save_store(store)

            sid = session["id"]
            meta = _session_meta(session)
            lc_messages = _to_lc_messages(session["messages"])

        # 2) 先告诉前端会话信息（新建的会话据此出现在侧边栏）
        emit({"type": "start", "session": meta})

        # 3) 逐字生成
        buffer: List[str] = []
        with _run_lock:
            # stream_mode="messages" 会逐 token 吐出 (AIMessageChunk, metadata)
            for chunk, meta_info in agent.stream({"messages": lc_messages}, stream_mode="messages"):
                # 工具节点产生的内容不推给前端
                if isinstance(meta_info, dict) and meta_info.get("langgraph_node") == "tools":
                    continue
                # 只负责「发起工具调用」的分片没有正文，直接跳过
                if getattr(chunk, "tool_call_chunks", None):
                    continue

                text = _extract_text(chunk)
                if text:
                    buffer.append(text)
                    emit({"type": "token", "content": text})

        answer = "".join(buffer).strip()

        # 4) 落盘 AI 回答
        if answer:
            with _store_lock:
                store = _load_store()
                target = store["sessions"].get(sid)
                if target is not None:
                    target["messages"].append(
                        {"role": "assistant", "content": answer, "ts": time.time()}
                    )
                    target["updated_at"] = time.time()
                    _save_store(store)
        else:
            emit({"type": "token", "content": "抱歉，本次没有生成有效回答，请换个说法再试一次。"})

        emit({"type": "done", "session_id": sid})

    except Exception as exc:  # noqa: BLE001 - 统一兜底，异常信息回传前端
        traceback.print_exc()
        emit({"type": "error", "content": f"服务处理失败：{type(exc).__name__}: {exc}"})


def _sse(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _event_stream(question: str, session_id: Optional[str]):
    """把同步 Agent 的逐字输出转换成 SSE 事件流。"""
    loop = asyncio.get_running_loop()
    queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue()

    def emit(payload: Dict[str, Any]) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, payload)

    threading.Thread(target=_run_agent, args=(session_id, question, emit), daemon=True).start()

    while True:
        try:
            payload = await asyncio.wait_for(queue.get(), timeout=15)
        except asyncio.TimeoutError:
            # 心跳保活，避免长时间工具调用被网关断开
            yield ": keep-alive\n\n"
            continue

        yield _sse(payload)
        if payload.get("type") in ("done", "error"):
            break


# ---------------------------------------------------------------------------
# 会话接口
# ---------------------------------------------------------------------------
@app.get("/sessions")
async def list_sessions() -> Dict[str, Any]:
    """历史会话列表（按最近更新排序，空会话不展示）。"""
    return {"sessions": _list_sessions()}


@app.get("/sessions/{session_id}")
async def get_session(session_id: str) -> Dict[str, Any]:
    """读取某个会话的全部消息，用于点击历史条目后回显。"""
    with _store_lock:
        store = _load_store()
    session = store["sessions"].get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在或已被删除")
    return {"session": {**_session_meta(session), "messages": session.get("messages", [])}}


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str) -> Dict[str, Any]:
    """删除单个会话。"""
    with _store_lock:
        store = _load_store()
        if session_id not in store["sessions"]:
            raise HTTPException(status_code=404, detail="会话不存在或已被删除")
        del store["sessions"][session_id]
        _save_store(store)
    return {"ok": True, "message": "会话已删除"}


@app.post("/sessions/{session_id}/clear")
async def clear_session(session_id: str) -> Dict[str, Any]:
    """只清空某个会话的消息，保留会话本身。"""
    with _store_lock:
        store = _load_store()
        session = store["sessions"].get(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="会话不存在或已被删除")
        session["messages"] = []
        session["title"] = "新对话"
        session["updated_at"] = time.time()
        _save_store(store)
    return {"ok": True, "message": "对话已清空"}


@app.post("/clear")
@app.get("/clear")
async def clear_all() -> Dict[str, Any]:
    """清空全部历史会话（保留接口兼容）。"""
    with _store_lock:
        _save_store(_empty_store())
    return {"ok": True, "message": "全部对话已清空"}


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"ok": True, "message": "服务正常运行"}


# ---------------------------------------------------------------------------
# 问答接口（SSE 流式）
# ---------------------------------------------------------------------------
def _stream_response(question: str, session_id: Optional[str]) -> StreamingResponse:
    return StreamingResponse(
        _event_stream(question, session_id),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    question = (req.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question 不能为空")
    return _stream_response(question, (req.session_id or "").strip() or None)


@app.get("/chat")
async def chat_get(
    question: str = Query(..., description="用户提问内容"),
    session_id: Optional[str] = Query(default=None, description="会话 ID"),
) -> StreamingResponse:
    """GET 版本，方便用浏览器 EventSource 直接调试。"""
    question = question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="question 不能为空")
    return _stream_response(question, (session_id or "").strip() or None)


# ---------------------------------------------------------------------------
# 静态资源：直接托管 frontend 目录，访问 http://127.0.0.1:8000 即可打开页面
# （必须放在所有 API 路由之后注册）
# ---------------------------------------------------------------------------
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
